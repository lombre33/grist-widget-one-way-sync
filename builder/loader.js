// Chargeur de la page « widget dans le document » (builder/build.mjs l'écrit en ligne dans la page, après les
// modules). Il tourne dans le cadre que Grist donne à un widget du Widget Creator : <iframe sandbox="allow-scripts"
// srcdoc>, une origine opaque. Sans allow-same-origin, la page n'a ni localStorage, ni sessionStorage, ni verrous Web
// (navigator.locks), et son BroadcastChannel ne parle à personne : le chargeur les remplace, puis charge les modules
// du widget tels quels, comme des modules JavaScript natifs (donc avec leurs liaisons vivantes), par des adresses
// blob: qu'il fabrique. Ce texte est signé dans la politique de sécurité de la page (son empreinte SHA-256) : tout
// changement ici change la politique, et le build la recalcule.
//
// Marques remplacées par le build avant de signer : SEEDS (préférences d'avance), ENTRY (rang du module de départ).
(function (win) {
  'use strict';
  const doc = win.document;
  const nav = win.navigator;
  const SEEDS = /*SEEDS*/{}/*END*/;
  const ENTRY = /*ENTRY*/0/*END*/;
  const NAME_PREFIX = 'syncplus-creator:';

  // Verrous : une file par nom, dans la page seulement. Deux onglets ouverts sur le même document ne se retiennent
  // plus l'un l'autre (c'est dit dans le guide) ; dans la page, la même garantie que navigator.locks.
  function installLocks() {
    const tails = new Map();
    const request = (name, options, callback) => {
      const run = typeof options === 'function' ? options : callback;
      const tail = tails.get(name);
      if (options && options.ifAvailable && tail) return Promise.resolve(run(null));
      const result = (tail || Promise.resolve()).then(() => run({ name, mode: 'exclusive' }));
      const settled = result.then(() => {}, () => {});
      tails.set(name, settled);
      settled.then(() => { if (tails.get(name) === settled) tails.delete(name); });
      return result;
    };
    Object.defineProperty(nav, 'locks', { configurable: true, value: { request } });
  }

  // Stockage : une mémoire de la page, gardée dans window.name (qui survit à un rechargement du cadre, pas à celui du
  // document). Les préférences d'avance (SEEDS) y sont posées au départ. Rien d'autre n'y est écrit que ce que le
  // widget range d'ordinaire dans son stockage : préférences, heure de visite, heure d'un assistant à rouvrir.
  function installStorage() {
    // Ce qui était rangé : deux objets de textes, ou rien (un window.name abîmé ou incomplet n'arrête jamais le chargement).
    const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    let saved = { local: {}, session: {} };
    try {
      if (String(win.name).startsWith(NAME_PREFIX)) {
        const read = JSON.parse(win.name.slice(NAME_PREFIX.length));
        saved = { local: plain(read && read.local), session: plain(read && read.session) };
      }
    } catch (e) { saved = { local: {}, session: {} }; }
    const mayPersist = win.name === '' || String(win.name).startsWith(NAME_PREFIX);
    const stores = { local: new Map(Object.entries({ ...SEEDS, ...saved.local })), session: new Map(Object.entries(saved.session)) };
    const persist = () => {
      if (!mayPersist) return;
      try { win.name = NAME_PREFIX + JSON.stringify({ local: Object.fromEntries(stores.local), session: Object.fromEntries(stores.session) }); } catch (e) { /* trop gros : tant pis */ }
    };
    const storage = map => ({
      getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
      setItem: (key, value) => { map.set(String(key), String(value)); persist(); },
      removeItem: key => { map.delete(String(key)); persist(); },
      clear: () => { map.clear(); persist(); },
      key: index => [...map.keys()][index] ?? null,
      get length() { return map.size; },
    });
    const local = storage(stores.local);
    const session = storage(stores.session);
    Object.defineProperty(win, 'localStorage', { configurable: true, get: () => local });
    Object.defineProperty(win, 'sessionStorage', { configurable: true, get: () => session });
  }

  // Le canal entre deux onglets : dans cette origine opaque, il ne joindrait que cette page. Sans lui, le widget n'offre
  // pas « Envoyer à un document ouvert dans ce navigateur » (tab-link.js : supported()).
  function removeChannel() {
    try { delete win.BroadcastChannel; } catch (e) { /* rien */ }
    if (win.BroadcastChannel) win.BroadcastChannel = undefined;
  }

  // Les modules, dans l'ordre où chacun ne cite que des modules déjà vus (le build l'a trié, et refuse un cycle) : un
  // texte par module, dont les adresses de modules sont des marques « @syncplus:<rang> » devenues des adresses blob:.
  async function readModules() {
    const packed = doc.getElementById('syncplus-payload');
    if (packed) return JSON.parse(await decode(packed.textContent));
    return [...doc.querySelectorAll('script[type="text/plain"][data-module]')].map(node => ({ id: node.dataset.module, text: node.textContent }));
  }

  // Charge utile compressée (build --compact) : base64 de gzip, lue par DecompressionStream.
  async function decode(text) {
    const bytes = Uint8Array.from(win.atob(text.replace(/\s+/g, '')), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new win.DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  async function start() {
    installLocks();
    installStorage();
    removeChannel();
    const modules = await readModules();
    if (!modules.length) return;
    const urls = [];
    for (const module of modules) {
      const text = module.text.replace(/(['"])@syncplus:(\d+)\1/g, (all, quote, rank) => {
        if (!urls[rank]) throw new Error(`${module.id} : module ${rank} pas encore chargé`);
        return `${quote}${urls[rank]}${quote}`;
      });
      const type = module.id.endsWith('.json') ? 'application/json' : 'text/javascript';
      urls.push(win.URL.createObjectURL(new Blob([text], { type })));
    }
    await import(urls[ENTRY]);
  }

  start().catch((error) => {
    console.error(error);
    const main = doc.getElementById('main');
    if (main) main.textContent = `Sync+ : le chargement a échoué (${error && error.message ? error.message : error}).`;
  });
}(window));
