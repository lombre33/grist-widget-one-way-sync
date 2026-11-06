// Mandataire devant un Grist de test (tests/e2e/start-grist.sh avec INTERNAL_PORT) : tout passe tel quel, sauf
// les envois de webhooks (POST sur /api/s/<clé>/...) quand un mode d'échec est réglé. Il sert aux tests de charge
// (tests/e2e/charge.mjs, CHAOS=1) : quotas (429), erreurs du serveur (500, 502, 503), connexion coupée, réponse qui
// ne vient jamais, réponse lente, un envoi sur N qui échoue. Les WebSockets (le widget écrit par là) sont relayés.
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const HOOK = /^\/(o\/[^/]+\/)?api\/s\//;

export function startChaosProxy({ port, target }) {
  // mode : 'pass' | 'status' (réponse `code`) | 'reset' | 'hang' | 'slow' (`delay` ms avant de relayer)
  // `every` : seul un envoi sur `every` est touché (1 : tous). `only` : seuls les envois dont l'adresse contient ce
  // texte (la clé d'un destinataire) sont touchés. `stats` : envois vus par mode.
  const chaos = { mode: 'pass', code: 500, delay: 0, every: 1, only: '', seen: 0, stats: {}, bodies: [] };
  const note = (key) => { chaos.stats[key] = (chaos.stats[key] || 0) + 1; };

  const forward = (req, res, body) => {
    const upstream = httpRequest({ host: 'localhost', port: target, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${target}` } }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    if (body) upstream.end(body); else req.pipe(upstream);
  };

  const server = createServer((req, res) => {
    const hit = req.method === 'POST' && HOOK.test(req.url) && (!chaos.only || req.url.includes(chaos.only));
    if (!hit || chaos.mode === 'pass') {
      if (hit) note('pass');
      return forward(req, res);
    }
    chaos.seen++;
    if (chaos.seen % chaos.every !== 0) {
      note('pass');
      return forward(req, res);
    }
    note(chaos.mode === 'status' ? `status ${chaos.code}` : chaos.mode);
    if (chaos.mode === 'reset') { req.resume(); return req.socket.destroy(); }
    if (chaos.mode === 'hang') { req.resume(); return undefined; }
    if (chaos.mode === 'status') {
      req.resume();
      res.writeHead(chaos.code, { 'Content-Type': 'application/json', ...(chaos.code === 429 ? { 'Retry-After': '5' } : {}) });
      return res.end(JSON.stringify({ error: chaos.code === 429 ? 'Too Many Requests' : 'chaos' }));
    }
    // slow : on lit tout le corps, on attend, puis on relaie
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => setTimeout(() => forward(req, res, Buffer.concat(chunks)), chaos.delay));
    return undefined;
  });

  server.on('upgrade', (req, socket, head) => {
    const upstream = connect(target, 'localhost', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, host: `localhost:${target}` }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise(resolve => server.listen(port, () => resolve({
    chaos,
    set(mode, options = {}) { Object.assign(chaos, { mode, code: 500, delay: 0, every: 1, only: '', seen: 0 }, options); },
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); }),
  })));
}
