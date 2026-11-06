// Tests de charge : deux Grist réels (SOURCE et CIBLE, tests/e2e/start-grist.sh), le widget dans un
// vrai navigateur, et des scénarios dont le but est de FAIRE ÉCHOUER la transmission : gros volumes,
// budget et pause, page fermée ou cachée, envois en échec, clés vides ou en double, valeurs
// étranges. Pour chaque échec trouvé, la correction (ou le message clair) est dans le code et le test
// reste ici comme garde-fou.
// Usage : node tests/e2e/charge.mjs            (tous les scénarios)
//         ONLY=volume,budget node tests/e2e/charge.mjs   (certains)
//         ROWS=30000 COLS=20 pour le scénario « volume » (défaut : 30000 lignes, 20 colonnes)
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createHarness, log, sleep } from './harness.mjs';
import { startChaosProxy } from './chaos-proxy.mjs';

// CHAOS=1 : le second Grist (start-grist.sh, voir chaos-proxy.mjs), dont les envois de webhooks passent par un
// mandataire qui échoue à la demande.
const chaosMode = Boolean(process.env.CHAOS);
// FAST_BUDGET=1 : le budget des renvois (20 Mo par 10 minutes) est réduit à 3 Mo par 2 minutes (le rang d'une minute est la plus petite tranche suivie) pour que la pause
// se voie en quelques minutes ; seul ce chiffre change, pas la logique.
const patches = process.env.FAST_BUDGET
  ? { '/js/logic/resend.js': text => text.replace('RESEND_BUDGET = 20000000', 'RESEND_BUDGET = 3000000').replace('BUDGET_WINDOW = 600', 'BUDGET_WINDOW = 120') }
  : {};
const h = await createHarness({ port: Number(process.env.PORT || 8586), envFile: chaosMode ? '.env-chaos.json' : '.env.json', patches });
const proxy = chaosMode ? await startChaosProxy({ port: Number(new URL(h.env.grist).port), target: Number(process.env.INTERNAL_PORT || 8493) }) : null;
const { env, api, records, sql, count, waitFor, webhooks, applyActions } = h;
// SHOTS=<dossier> : capture de la page (le widget dans Grist) à quelques moments clés.
const shot = async (view, name) => {
  if (!process.env.SHOTS) return;
  await mkdir(process.env.SHOTS, { recursive: true });
  await view.page.setViewportSize({ width: 1100, height: 900 });
  await sleep(500);
  await view.page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

import { columnsOf, makeRow } from './data.mjs';

// Ce que la CIBLE montre pour un journal : lignes brutes pas encore dépliées, lignes dépliées.
async function journalState(p) {
  const raw = await count(p.dst.doc, p.journal, `where "Synchro_Type" is not null and "Synchro_Type" != ''`);
  const all = await count(p.dst.doc, p.journal);
  return { raw, unpacked: all - raw };
}
// Suivi toutes les `every` secondes jusqu'à `done` ; chaque ligne est un point de la courbe.
async function follow(p, what, done, { timeout, every = 15000, dest = p.dest } = {}) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const [n, j, hooks] = await Promise.all([count(p.dst.doc, dest), journalState(p), webhooks(p.src.doc)]);
    const hook = hooks[0] ? hooks[0].usage : {};
    const line = `${what}: CIBLE ${n} lignes, journal ${j.raw} brutes / ${j.unpacked} dépliées, file SOURCE ${hook ? hook.numWaiting : '?'} (${hook ? hook.status : '?'}, http ${hook ? hook.lastHttpStatus : '?'})`;
    if (line !== last) log(line);
    last = line;
    if (await done(n, j)) return { n, j };
    if (Date.now() - t0 > timeout) throw new Error(`Délai dépassé : ${what} (${line})`);
    await sleep(every);
  }
}

const scenarios = {
  // Contrôle du banc : une petite table passe du premier coup.
  async smoke() {
    const p = await h.pair({ name: 'Smoke', table: 'Contacts', columns: columnsOf(6), rows: 300, makeRow, send: 'wait' });
    await follow(p, 'smoke', n => n === 300, { timeout: 120000, every: 3000 });
    assert.equal(await count(p.dst.doc, p.dest), 300);
  },

  // Le cas de l'utilisateur : ROWS lignes × COLS colonnes, envoi de l'existant avec la page SOURCE et la
  // page CIBLE ouvertes. Rien ne doit manquer à l'arrivée, et ce qui prend du temps doit se voir.
  async volume() {
    const rows = Number(process.env.ROWS || 30000);
    const cols = Number(process.env.COLS || 20);
    log(`volume : ${rows} lignes × ${cols} colonnes`);
    const p = await h.pair({ name: `Volume ${rows}x${cols}`, table: 'Contacts', columns: columnsOf(cols), rows, makeRow, send: 'start' });
    log('envoi de l\'existant lancé');
    await follow(p, 'volume', n => n === rows, { timeout: 3 * 3600 * 1000, every: 20000 });
    assert.equal(await count(p.dst.doc, p.dest), rows);
    log(`volume : ${rows} lignes arrivées`);
  },

  // Valeurs étranges : chacune doit arriver telle quelle, ou à défaut vide, sans jamais empêcher les autres
  // lignes d'arriver (un nombre « NaN » ou « Infinity » n'est pas du JSON : il rendait tout le lot illisible).
  async valeursEtranges() {
    const BIG = 'x'.repeat(200000);
    const specials = [
      { Nom: 'normal', Txt: 'bonjour', Num: 1.5 },
      { Nom: 'controle', Txt: 'a\u0001b\u001fc d e\té\n"guillemets" \\ antislash', Num: 0 },
      { Nom: 'emoji', Txt: '😀 𝄞 日本語 مرحبا', Num: -0.0 },
      { Nom: 'grandTexte', Txt: BIG, Num: 3 },
      { Nom: 'petitsNombres', Txt: 'p', Num: 0.1 + 0.2 },
      { Nom: 'grosNombres', Txt: 'g', Num: 1.7976931348623157e308 },
      { Nom: 'entierGeant', Txt: 'e', Num: 9007199254740993 },
      { Nom: 'vide', Txt: '', Num: null },
    ];
    const p = await h.pair({
      name: 'Valeurs étranges', table: 'Etrange', exportName: 'Etrange',
      columns: [{ id: 'Nom', type: 'Text' }, { id: 'Txt', type: 'Text' }, { id: 'Num', type: 'Numeric' }, { id: 'Entier', type: 'Int' }, { id: 'Jour', type: 'Date' }, { id: 'Instant', type: 'DateTime:UTC' }],
      rows: specials.length, makeRow: i => ({ ...specials[i], Entier: 7, Jour: 86400 * 365, Instant: 1.7e9 }), send: 'wait',
      // Colonnes calculées qui rendent des valeurs que JSON n'écrit pas, ajoutées avant l'export.
      beforeExport: ({ src }) => applyActions(src.doc, [
        ['AddColumn', 'Etrange', 'FNan', { type: 'Numeric', isFormula: true, formula: "float('nan') if $Nom == 'normal' else 1.0" }],
        ['AddColumn', 'Etrange', 'FInf', { type: 'Numeric', isFormula: true, formula: "float('inf') if $Nom == 'controle' else -float('inf') if $Nom == 'emoji' else 2.0" }],
        ['AddColumn', 'Etrange', 'FErreur', { type: 'Numeric', isFormula: true, formula: "1 / 0 if $Nom == 'vide' else 3.0" }],
        ['AddColumn', 'Etrange', 'FDate', { type: 'Date', isFormula: true, formula: 'datetime.date(1, 1, 1) if $Nom == "normal" else datetime.date(9999, 12, 31)' }],
      ]),
    });
    const got = await waitFor(async () => { const r = await records(p.dst.doc, 'Etrange'); return r.length >= 1 && r; }, 'première ligne reçue', 120000, 2000);
    await sleep(15000);
    const srcRows = await records(p.src.doc, 'Etrange');
    const dstRows = await records(p.dst.doc, 'Etrange');
    log(`SOURCE ${srcRows.length} lignes, CIBLE ${dstRows.length} lignes (premier relevé : ${got.length})`);
    const byKey = new Map(dstRows.map(r => [r.id_sync, r]));
    const diffs = [];
    for (const r of srcRows) {
      const d = byKey.get(r.id_sync);
      if (!d) { diffs.push(`${r.Nom} : ligne absente de la CIBLE`); continue; }
      for (const col of ['Txt', 'Num', 'Entier', 'Jour', 'Instant', 'FNan', 'FInf', 'FErreur', 'FDate']) {
        const a = JSON.stringify(r[col]).slice(0, 60); const b = JSON.stringify(d[col]).slice(0, 60);
        if (a !== b) diffs.push(`${r.Nom}.${col} : SOURCE ${a} → CIBLE ${b}`);
      }
    }
    log(`écarts :\n  ${diffs.join('\n  ') || '(aucun)'}`);
    log(`carte CIBLE : ${(await p.dv.text()).slice(0, 600)}`);
    assert.equal(dstRows.length, srcRows.length, 'toutes les lignes arrivent');
    assert.deepEqual(diffs, [], 'chaque valeur arrive telle quelle');
    const nan = dstRows.find(r => r.Nom === 'normal');
    assert.ok(nan.FNan === null || nan.FNan === '' || nan.FNan === undefined, 'NaN arrive vide');
    assert.ok(!/Arrivées suspectes/.test(await p.dv.text()), 'aucune alerte d\'arrivée suspecte');
  },

  // Clés vides et clés en double dans la SOURCE (lignes dupliquées dans Grist : la clé est copiée avec la ligne ; cellule
  // effacée). Rien ne part pour une clé vide ; deux lignes de même clé n'en font qu'une ici. Ce que le
  // widget en dit aux deux personnes doit se lire.
  async doublons() {
    const rows = 2000;
    const p = await h.pair({ name: 'Doublons', table: 'Contacts', columns: columnsOf(6), rows, makeRow, send: 'wait' });
    await follow(p, 'doublons', n => n === rows, { timeout: 300000, every: 3000 });
    const ids = (await records(p.src.doc, 'Contacts')).map(r => ({ id: r.id, key: r.id_sync }));
    const dup = ids.slice(10, 20); const blank = ids.slice(20, 30);
    await applyActions(p.src.doc, [
      ['BulkUpdateRecord', 'Contacts', dup.map(r => r.id), { id_sync: ids.slice(0, 10).map(r => r.key) }],
      ['BulkUpdateRecord', 'Contacts', blank.map(r => r.id), { id_sync: blank.map(() => '') }],
      ['BulkAddRecord', 'Contacts', [null, null, null, null, null], { Nom: ['n1', 'n2', 'n3', 'n4', 'n5'] }],
    ]);
    log('10 clés en double, 10 clés vides, 5 lignes ajoutées');
    await sleep(40000);
    const [src, dst] = [await count(p.src.doc, 'Contacts'), await count(p.dst.doc, p.dest)];
    log(`SOURCE ${src} lignes, CIBLE ${dst} lignes (écart ${src - dst})`);
    await p.sv.open(p.src.url);
    await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    const notice = p.sv.widget().locator('[data-keys]');
    await notice.waitFor({ timeout: 30000 });
    log(`carte SOURCE : ${(await notice.innerText()).replace(/\s+/g, ' ')}`);
    await p.dv.open(p.dst.url);
    await sleep(12000);
    log(`carte CIBLE : ${(await p.dv.text()).slice(0, 700)}`);
    assert.ok(await notice.getByText(/10 lignes sans clé/).count(), 'la SOURCE dit combien de lignes sont sans clé');
    assert.ok(await notice.getByText(/10 lignes qui partagent/).count(), 'la SOURCE dit combien de lignes partagent une clé');
    // Réparation : clés neuves, les lignes repartent, la CIBLE rattrape la SOURCE.
    await p.sv.open(p.src.url);
    await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    await p.sv.button('Réparer les clés').click();
    await p.sv.dialogButton('Réparer les clés').click();
    await notice.waitFor({ state: 'detached', timeout: 60000 });
    await waitFor(async () => (await count(p.dst.doc, p.dest)) === src, 'la CIBLE rattrape la SOURCE', 120000, 3000);
    const keys = (await records(p.src.doc, 'Contacts')).map(r => r.id_sync);
    assert.equal(new Set(keys).size, src, 'toutes les lignes ont une clé à elles');
    const names = new Set((await records(p.dst.doc, p.dest)).map(r => r.Nom));
    assert.equal(names.size, src, 'chaque ligne de la SOURCE est ici');
    log(`après réparation : SOURCE ${src} lignes, CIBLE ${await count(p.dst.doc, p.dest)} lignes`);
  },

  // Page SOURCE fermée en plein envoi : l'envoi s'arrête là, et reprend à la réouverture sans rien perdre ni
  // doubler. Pendant l'arrêt, la CIBLE doit dire que des lignes manquent.
  async sourceFermee() {
    const rows = Number(process.env.ROWS || 30000);
    const p = await h.pair({ name: 'Source fermée', table: 'Contacts', columns: columnsOf(20), rows, makeRow, send: 'start' });
    await waitFor(async () => (await count(p.dst.doc, p.dest)) > rows / 10, 'dix pour cent arrivés', 600000, 1000);
    await p.sv.page.goto('about:blank');
    log(`page SOURCE fermée à ${await count(p.dst.doc, p.dest)} lignes`);
    await sleep(90000);
    const stuck = await count(p.dst.doc, p.dest);
    log(`90 s plus tard : ${stuck} lignes`);
    await p.dv.open(p.dst.url);
    await sleep(15000);
    log(`carte CIBLE : ${(await p.dv.text()).slice(0, 900)}`);
    await p.sv.open(p.src.url);
    await follow(p, 'sourceFermee (rouverte)', n => n === rows, { timeout: 1800000, every: 10000 });
    assert.equal(await count(p.dst.doc, p.dest), rows);
  },

  // Un destinataire dont le document a été supprimé (le lien de réception renvoie 404) : la file d'envoi de Grist
  // est commune au document SOURCE, donc l'autre destinataire, lui, en bonne santé, attend derrière l'envoi
  // qui échoue (20 essais espacés jusqu'à 64 s, soit un quart d'heure, puis l'envoi repart en fin de file et
  // bloque de nouveau au suivant). FIX choisit ce que fait la personne : none (rien : on mesure le blocage),
  // pause, revoke, unblock, auto (rien à la main : le widget met seul le lien mort en pause). Sauf none, l'autre
  // destinataire doit recevoir tout de suite (auto : au bout d'une à deux minutes).
  async destinataireMort() {
    const fix = process.env.FIX || 'none';
    const rows = 600;
    const a = await h.pair({ name: 'Mort A', table: 'Contacts', columns: columnsOf(6), rows, makeRow, send: 'wait' });
    await follow(a, 'A reçoit', n => n === rows, { timeout: 120000, every: 3000 });
    const b = await h.addRecipient(a, { name: 'Mort B', send: 'wait' });
    await waitFor(async () => (await count(b.dst.doc, 'Contacts')) === rows, 'B reçoit', 120000, 2000);
    log(`A et B ont les ${rows} lignes ; suppression du document de A (réaction : ${fix})`);
    await h.request('DELETE', `/docs/${a.dst.doc}`);
    const ids = (await records(a.src.doc, 'Contacts')).slice(0, 5).map(r => r.id);
    await applyActions(a.src.doc, [['BulkUpdateRecord', 'Contacts', ids, { Ville: ids.map(() => 'Mort1') }]]);
    const t0 = Date.now();
    const bGot = async () => (await count(b.dst.doc, 'Contacts', `where "Ville" = 'Mort1'`)) === 5;
    const queues = async () => JSON.stringify((await webhooks(a.src.doc)).map(w => [w.usage.status, w.usage.numWaiting, w.usage.lastHttpStatus]));
    // Blocage constaté : B n'a rien au bout de 45 s alors que A échoue.
    await sleep(45000);
    assert.ok(!(await bGot()), 'B est bloqué derrière l\'envoi mort (comportement de Grist)');
    log(`B bloqué depuis ${Math.round((Date.now() - t0) / 1000)} s ; files : ${await queues()}`);
    await a.sv.open(a.src.url);
    await a.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    await sleep(4000);
    log(`carte SOURCE : ${(await a.sv.text()).slice(0, 1800)}`);
    await shot(a.sv, 'mort-erreur');
    const rowA = a.sv.widget().locator('li.person').filter({ has: a.sv.widget().locator('.person-who', { hasText: 'Mort A' }) });
    const t1 = Date.now();
    if (fix === 'auto') log('rien n\'est fait à la main : le widget doit mettre le destinataire mort en pause tout seul (page SOURCE ouverte)');
    if (fix === 'pause') await rowA.getByRole('button', { name: 'Mettre en pause', exact: true }).click();
    if (fix === 'revoke') { await rowA.getByRole('button', { name: 'Révoquer', exact: true }).click(); await a.sv.dialogButton('Révoquer').click(); }
    if (fix === 'unblock') { await rowA.getByRole('button', { name: 'Débloquer la file', exact: true }).click(); await a.sv.dialogButton('Débloquer la file').click(); }
    let seen = 0;
    const patience = fix === 'none' ? 120 : 240;
    for (let i = 0; i < patience / 5 && !seen; i++) {
      await sleep(5000);
      if (await bGot()) seen = Math.round((Date.now() - t1) / 1000);
      else if (i % 4 === 3) log(`B n'a pas encore la modification (${Math.round((Date.now() - t1) / 1000)} s après la réaction) ; files : ${await queues()}`);
    }
    log(seen ? `B reçoit la modification ${seen} s après la réaction (${fix})` : `B ne reçoit pas la modification en ${patience} s (${fix})`);
    if (fix !== 'none') assert.ok(seen, `le destinataire en bonne santé reçoit après « ${fix} » du destinataire mort`);
    if (fix === 'auto') {
      await a.sv.open(a.src.url);
      await a.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
      await sleep(4000);
      const card = await a.sv.text();
      log(`carte SOURCE après la pause automatique : ${card.slice(0, 1200)}`);
      await shot(a.sv, 'mort-pause-auto');
      assert.match(card, /Mise en pause par le widget/, 'la carte dit que le widget a mis ce destinataire en pause');
    }
  },

  // CHAOS=1. Un destinataire dont le serveur ne répond jamais (connexion ouverte, pas de réponse) : Grist n'a pas de
  // délai d'attente, l'envoi reste « en cours » et la file de tout le document attend (vu : plus de 20 minutes sans
  // reprise). Le widget doit le dire au bout de trois minutes, puis, page SOURCE ouverte, mettre ce destinataire en
  // pause d'office : l'autre reçoit alors sans rien faire à la main.
  async destinataireMuet() {
    assert.ok(proxy, 'scénario réservé à CHAOS=1');
    const rows = 100;
    const a = await h.pair({ name: 'Muet A', table: 'Contacts', columns: columnsOf(6), rows, makeRow, send: 'wait' });
    await follow(a, 'A reçoit', n => n === rows, { timeout: 120000, every: 3000 });
    const b = await h.addRecipient(a, { name: 'Muet B', send: 'wait' });
    await waitFor(async () => (await count(b.dst.doc, 'Contacts')) === rows, 'B reçoit', 120000, 2000);
    const [hookA] = await webhooks(a.src.doc);
    const keyA = /\/api\/s\/([^/]+)\//.exec(hookA.fields.url)[1];
    proxy.set('hang', { only: keyA });
    log('le serveur de A ne répond plus (la connexion reste ouverte)');
    await a.sv.open(a.src.url);
    await a.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    const ids = (await records(a.src.doc, 'Contacts')).slice(0, 5).map(r => r.id);
    await applyActions(a.src.doc, [['BulkUpdateRecord', 'Contacts', ids, { Ville: ids.map(() => 'Muet1') }]]);
    const t0 = Date.now();
    const bGot = async () => (await count(b.dst.doc, 'Contacts', `where "Ville" = 'Muet1'`)) === 5;
    let said = 0;
    let got = 0;
    for (let i = 0; i < 90 && !got; i++) {
      await sleep(5000);
      if (!said && /ne répond pas/.test(await a.sv.text())) { said = Math.round((Date.now() - t0) / 1000); log(`la carte dit « ne répond pas » après ${said} s`); }
      if (await bGot()) got = Math.round((Date.now() - t0) / 1000);
      else if (i % 6 === 5) log(`B n'a pas encore la modification (${Math.round((Date.now() - t0) / 1000)} s) ; files : ${JSON.stringify((await webhooks(a.src.doc)).map(w => [w.usage.status, w.usage.numWaiting]))}`);
    }
    log(got ? `B reçoit la modification ${got} s après la panne de A` : 'B ne reçoit pas la modification en 7 minutes');
    proxy.set('pass');
    await a.sv.open(a.src.url);
    await a.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    await sleep(4000);
    const card = await a.sv.text();
    log(`carte SOURCE : ${card.slice(0, 1200)}`);
    assert.ok(said, 'la carte dit que le destinataire ne répond pas');
    assert.ok(got, 'B reçoit sans rien faire à la main');
    assert.match(card, /Mise en pause par le widget : un envoi vers cette personne attendait/, 'la carte dit pourquoi le destinataire est en pause');
  },

  // CHAOS=1. Envois de webhooks qui échouent : quota (429), erreurs du serveur (500, 503), connexion coupée,
  // réponse qui ne vient jamais, réponse lente. Pour chacun : ce que Grist note de l'échec (texte réel), ce que
  // la SOURCE en dit, et la reprise seule quand le mal est passé.
  async webhooksEnEchec() {
    assert.ok(proxy, 'scénario réservé à CHAOS=1');
    const rows = 300;
    const modes = (process.env.MODES || 'status:429,status:500,status:503,reset,hang,slow').split(',');
    const p = await h.pair({ name: 'Webhooks en échec', table: 'Contacts', columns: columnsOf(6), rows, makeRow, send: 'wait' });
    await follow(p, 'départ', n => n === rows, { timeout: 120000, every: 3000 });
    const ids = (await records(p.src.doc, 'Contacts')).slice(0, 3).map(r => r.id);
    const usageOf = async () => { const w = (await webhooks(p.src.doc))[0]; return { ...w.usage, lastBatch: undefined, lastEventBatch: undefined }; };
    for (const spec of modes) {
      const [mode, arg] = spec.split(':');
      const mark = `${spec}-${Date.now() % 100000}`;
      proxy.set(mode, mode === 'status' ? { code: Number(arg) } : mode === 'slow' ? { delay: 20000 } : {});
      await applyActions(p.src.doc, [['BulkUpdateRecord', 'Contacts', ids, { Ville: ids.map(() => mark) }]]);
      const t0 = Date.now();
      await sleep(30000);
      const during = await usageOf();
      const stuck = await count(p.dst.doc, p.dest, `where "Ville" = '${mark}'`);
      await p.sv.open(p.src.url);
      await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
      await sleep(3000);
      const card = (await p.sv.text()).replace(/^.*Nouvel export/, '').slice(0, 700);
      log(`[${spec}] pendant la panne (30 s) : arrivées ${stuck}/3 ; Grist : ${JSON.stringify(during)}`);
      log(`[${spec}] carte SOURCE : ${card}`);
      proxy.set('pass');
      const back = await waitFor(async () => (await count(p.dst.doc, p.dest, `where "Ville" = '${mark}'`)) === 3, `reprise après ${spec}`, 1200000, 5000).then(() => (Date.now() - t0) / 1000, () => null);
      const after = await usageOf();
      log(`[${spec}] reprise : ${back ? `${Math.round(back)} s après le début de la panne` : 'PAS DE REPRISE en 20 min'} ; Grist : ${JSON.stringify(after)}`);
      assert.ok(back, `les envois reprennent après ${spec}`);
      assert.ok(!(after.lastHttpStatus >= 400) || after.status === 'idle', `l'état d'envoi revient à la normale après ${spec}`);
    }
    log(`envois vus par le mandataire : ${JSON.stringify(proxy.chaos.stats)}`);
  },

  // FAST_BUDGET=1. Budget des renvois et pause « ménager le serveur » : l'envoi de l'existant dépasse le budget,
  // attend, reprend, et finit ; une modification ordinaire pendant la pause part tout de suite ; la page SOURCE
  // fermée pendant la pause, le renvoi reprend à la réouverture. La pause se lit dans la ligne `charge` de Synchro
  // (`reprise` : heure de reprise), la même que la carte affiche.
  async budget() {
    assert.ok(process.env.FAST_BUDGET, 'scénario réservé à FAST_BUDGET=1');
    const rows = Number(process.env.ROWS || 20000);
    const p = await h.pair({ name: 'Budget', table: 'Contacts', columns: columnsOf(20), rows, makeRow, send: 'start' });
    const t0 = Date.now();
    const chargeOf = async () => {
      const row = (await records(p.src.doc, 'Synchro')).find(r => r.Synchro_Type === 'charge');
      return row && row.Synchro_Renvoi ? JSON.parse(row.Synchro_Renvoi) : {};
    };
    const pauses = [];
    let last = 0;
    let edited = null;
    let closed = false;
    for (;;) {
      const [state, n] = await Promise.all([chargeOf(), count(p.dst.doc, p.dest)]);
      const now = Date.now() / 1000;
      if (state.reprise > now && state.reprise !== last) {
        last = state.reprise;
        pauses.push({ at: Math.round((Date.now() - t0) / 1000), until: Math.round(state.reprise - now), rows: n });
        log(`pause n°${pauses.length} à ${pauses.at(-1).at} s (${n} lignes arrivées), reprise dans ${pauses.at(-1).until} s`);
        if (!edited) {
          // Une modification ordinaire part même pendant la pause.
          const [first] = await records(p.src.doc, 'Contacts');
          await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', first.id, { Ville: 'PendantLaPause' }]]);
          edited = await waitFor(async () => (await count(p.dst.doc, p.dest, `where "Ville" = 'PendantLaPause'`)) === 1, 'modification pendant la pause', 60000, 1000).then(() => true, () => false);
          log(`modification ordinaire pendant la pause : ${edited ? 'arrivée' : 'PAS arrivée en 60 s'}`);
        } else if (!closed && pauses.length === 2) {
          // Page SOURCE fermée pendant une pause : la reprise attend la réouverture.
          closed = true;
          await p.sv.page.goto('about:blank');
          log('page SOURCE fermée pendant la pause');
          await sleep(Math.max(60, state.reprise - now + 20) * 1000);
          const stuck = await count(p.dst.doc, p.dest);
          await p.sv.open(p.src.url);
          log(`page SOURCE rouverte à ${stuck} lignes`);
        }
      }
      if (n === rows) break;
      if (Date.now() - t0 > 1800000) throw new Error(`Délai dépassé : budget (${n}/${rows})`);
      await sleep(2000);
    }
    log(`envoi complet en ${Math.round((Date.now() - t0) / 1000)} s avec ${pauses.length} pauses : ${JSON.stringify(pauses)}`);
    assert.ok(pauses.length >= 1, 'le budget a imposé au moins une pause');
    assert.ok(edited, 'une modification ordinaire part même pendant la pause');
    assert.equal(await count(p.dst.doc, p.dest), rows);
  },

  // Une cellule plus grosse que ce qu'un envoi de Grist accepte (1 Mo) : la ligne ne peut pas partir, et ne doit
  // ni bloquer la file ni faire disparaître les autres. La carte de la CIBLE doit dire laquelle manque.
  async celluleGeante() {
    const rows = 300;
    const p = await h.pair({
      name: 'Cellule géante', table: 'Contacts', columns: columnsOf(10), rows, makeRow, send: 'skip',
      // L'API de Grist refuse un corps de plus de 1 Mo : deux cellules de 900 ko, écrites en deux fois, font une
      // ligne d'environ 1,8 Mo (ce qu'une formule ou plusieurs personnes peuvent faire).
      beforeExport: async ({ src }) => {
        const own = Object.fromEntries(columnsOf(10).map(c => [c.id, makeRow(rows)[c.id]]));
        await applyActions(src.doc, [['AddRecord', 'Contacts', null, { ...own, Nom: 'Géante', Adresse: 'x'.repeat(900000) }]]);
        const last = (await records(src.doc, 'Contacts')).find(r => r.Nom === 'Géante');
        await applyActions(src.doc, [['UpdateRecord', 'Contacts', last.id, { Commentaire: 'y'.repeat(900000) }]]);
      },
    });
    await p.sv.open(p.src.url);
    await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    await p.sv.button('Tout renvoyer').click();
    await p.sv.widget().getByText(/Renvoi terminé|Un autre renvoi est en cours/).waitFor({ timeout: 300000 }).catch(() => {});
    await sleep(20000);
    await p.dv.open(p.dst.url);
    await sleep(15000);
    const n = await count(p.dst.doc, p.dest);
    log(`CIBLE ${n} lignes sur ${rows + 1}`);
    log(`carte CIBLE : ${(await p.dv.text()).slice(0, 900)}`);
    log(`carte SOURCE : ${(await (async () => { await p.sv.open(p.src.url); await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click(); await sleep(3000); return p.sv.text(); })()).slice(0, 900)}`);
    const hook = (await webhooks(p.src.doc))[0].usage;
    log(`file SOURCE : ${hook.status} ${hook.numWaiting} http ${hook.lastHttpStatus}`);
    assert.ok(n >= rows, 'les autres lignes arrivent');
    assert.ok(!(hook.lastHttpStatus >= 400) && hook.status !== 'retrying', 'la file n\'est pas bloquée par la cellule géante');
  },

  // Beaucoup de colonnes : 120 colonnes de texte, 2 000 lignes (chaque ligne répète tous les noms de colonnes dans le lot).
  async colonnesLarges() {
    const rows = Number(process.env.ROWS || 2000);
    const cols = Array.from({ length: Number(process.env.COLS || 120) }, (_, i) => ({ id: `Champ${i}`, type: 'Text' }));
    const make = i => Object.fromEntries(cols.map((c, k) => [c.id, `valeur ${i} champ ${k}`]));
    const p = await h.pair({ name: 'Colonnes larges', table: 'Contacts', columns: cols, rows, makeRow: make, send: 'start' });
    await follow(p, 'colonnes larges', n => n === rows, { timeout: 1200000, every: 10000 });
    const sample = (await records(p.dst.doc, p.dest)).find(r => r.Champ0 === 'valeur 7 champ 0');
    assert.ok(sample && sample.Champ119 === 'valeur 7 champ 119', 'toutes les colonnes sont arrivées');
  },

  // Grande table : 100 000 lignes de 5 colonnes (la liste des clés se fait en seaux, le lot en tranches).
  async grandeTable() {
    const rows = Number(process.env.ROWS || 100000);
    const p = await h.pair({ name: 'Grande table', table: 'Contacts', columns: columnsOf(5), rows, makeRow, send: 'start' });
    await follow(p, 'grande table', n => n === rows, { timeout: 3 * 3600 * 1000, every: 30000 });
    await sleep(30000);
    const hook = (await webhooks(p.src.doc))[0].usage;
    log(`fin : ${await count(p.dst.doc, p.dest)} lignes, file SOURCE ${hook.status} ${hook.numWaiting}`);
    assert.equal(await count(p.dst.doc, p.dest), rows);
  },

  // Trois destinataires pour une même table de 8 000 lignes de 20 colonnes : chaque renvoi compte pour trois dans
  // le budget, la file de Grist est commune. Tous doivent finir avec la table entière.
  async plusieursDestinataires() {
    const rows = Number(process.env.ROWS || 8000);
    const p = await h.pair({ name: 'Trois destinataires', table: 'Contacts', columns: columnsOf(20), rows, makeRow, send: 'wait' });
    const b = await h.addRecipient(p, { name: 'Trois B', send: 'start' });
    const c = await h.addRecipient(p, { name: 'Trois C', send: 'start' });
    const t0 = Date.now();
    await waitFor(async () => {
      const ns = await Promise.all([p, b, c].map(x => count(x.dst.doc, x.dest)));
      log(`destinataires : ${ns.join(' / ')} lignes (${Math.round((Date.now() - t0) / 1000)} s)`);
      return ns.every(n => n === rows);
    }, 'les trois destinataires ont tout', 1800000, 15000);
  },

  // Beaucoup de destinataires sur peu de lignes (RECIPIENTS=256, 10 lignes) : un seul vrai destinataire, les autres
  // sont des webhooks créés à la main sur la même adresse d'écriture (la file de Grist et la carte de la SOURCE ne
  // voient pas la différence ; la CIBLE reçoit tout dans un seul journal). On mesure : l'ouverture de l'onglet
  // Envoyer (requêtes faites, durée), une rafale de modifications (chaque écriture × tous les destinataires contre
  // la file de 1 000 envois de Grist), la vidange de la file, puis la même rafale avec un destinataire mort.
  async beaucoupDestinataires() {
    const total = Number(process.env.RECIPIENTS || 256);
    const rows = 10;
    const p = await h.pair({ name: 'Beaucoup de destinataires', table: 'Contacts', columns: columnsOf(6), rows, makeRow, send: 'wait' });
    await follow(p, 'départ', n => n === rows, { timeout: 120000, every: 3000 });
    const [first] = await webhooks(p.src.doc);
    const trigger = (await records(p.src.doc, '_grist_Triggers'))[0];
    const condition = JSON.parse(trigger.condition || '{}').text;
    const t0 = Date.now();
    for (let i = 2; i <= total; i += 25) {
      const batch = Array.from({ length: Math.min(25, total - i + 1) }, (_, k) => ({ fields: {
        name: `Synchro factice ${i + k} #${p.exportId}`, memo: first.fields.memo.replace(/^[^ ]+/, `factice${i + k}@sync.local`), url: first.fields.url,
        tableId: 'Synchro', condition, eventTypes: ['add', 'update'], enabled: true, isReadyColumn: null } }));
      await api('POST', `/docs/${p.src.doc}/webhooks`, { webhooks: batch });
    }
    log(`${total} destinataires en place (${Math.round((Date.now() - t0) / 1000)} s)`);
    // Ouverture de l'onglet Envoyer : durée et requêtes de contrôle faites par le widget.
    const gets = [];
    p.sv.page.on('request', r => { if (/\/api\/s\/[^/]+$/.test(new URL(r.url()).pathname)) gets.push(r.url()); });
    const t1 = Date.now();
    await p.sv.open(p.src.url);
    await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    await p.sv.widget().locator('li.person').nth(total - 1).waitFor({ timeout: 120000 });
    log(`onglet Envoyer : ${total} destinataires affichés en ${Math.round((Date.now() - t1) / 1000)} s ; ${gets.length} contrôles de lien envoyés`);
    await sleep(15000);
    log(`après 15 s : ${gets.length} contrôles de lien au total`);
    // Rafale : dix modifications de suite, chacune part vers tous les destinataires.
    const ids = (await records(p.src.doc, 'Contacts')).map(r => r.id);
    const queue = async () => (await webhooks(p.src.doc)).reduce((n, w) => n + ((w.usage && w.usage.numWaiting) || 0), 0);
    const burst = async (mark) => {
      const times = [];
      const b0 = Date.now();
      for (let i = 0; i < ids.length; i++) {
        const w0 = Date.now();
        await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', ids[i], { Ville: `${mark}${i}` }]]);
        times.push(Date.now() - w0);
      }
      log(`rafale ${mark} : écritures en ${Math.round((Date.now() - b0) / 1000)} s (durée de chaque écriture, ms : ${times.join(' ')}) ; file ${await queue()}`);
      return b0;
    };
    const b0 = await burst('R');
    await waitFor(async () => {
      const q = await queue();
      log(`file : ${q} envois (${Math.round((Date.now() - b0) / 1000)} s)`);
      return q === 0;
    }, 'la file se vide', 900000, 10000);
    log(`file vidée ${Math.round((Date.now() - b0) / 1000)} s après le début de la rafale`);
    const t2 = Date.now();
    await waitFor(async () => (await count(p.dst.doc, p.dest, `where "Ville" like 'R%'`)) === rows, 'la CIBLE a toutes les modifications', 300000, 5000);
    log(`la CIBLE a les ${rows} modifications ${Math.round((Date.now() - t2) / 1000)} s après la vidange de la file`);
    // Un destinataire mort parmi les autres : la même rafale, la file se bloque derrière lui.
    const victim = (await webhooks(p.src.doc))[total >> 1];
    await api('PATCH', `/docs/${p.src.doc}/webhooks/${victim.id}`, { url: victim.fields.url.replace(/\/api\/s\/[^/]+/, '/api/s/cleinconnue') });
    const c0 = await burst('M');
    await sleep(60000);
    log(`avec un destinataire mort : après 60 s, file ${await queue()} ; CIBLE ${await count(p.dst.doc, p.dest, `where "Ville" like 'M%'`)}/${rows} lignes à jour`);
    await p.sv.open(p.src.url);
    await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    await sleep(5000);
    const card = await p.sv.text();
    log(`carte SOURCE (début) : ${card.slice(0, 700)}`);
    log(`erreurs affichées : ${(card.match(/Erreur/g) || []).length} ; « attend derrière » : ${(card.match(/attend derrière/g) || []).length}`);
    void c0;
  },

  // Toute la table modifiée d'un coup, puis des milliers de lignes ajoutées d'un coup : le lot de la SOURCE est
  // coupé (250 ko), le rattrapage envoie la suite page ouverte, et la CIBLE doit rejoindre la SOURCE sans rien
  // perdre ni doubler.
  async modifMasse() {
    const rows = Number(process.env.ROWS || 6000);
    const p = await h.pair({ name: 'Modification de masse', table: 'Contacts', columns: columnsOf(20), rows, makeRow, send: 'wait' });
    await follow(p, 'départ', n => n === rows, { timeout: 900000, every: 5000 });
    const inCible = (col, value) => count(p.dst.doc, p.dest, `where "${col}" = '${value}'`);
    const ids = (await records(p.src.doc, 'Contacts')).map(r => r.id);
    const t0 = Date.now();
    await applyActions(p.src.doc, [['BulkUpdateRecord', 'Contacts', ids, { Ville: ids.map(() => 'Masse'), Pays: ids.map(() => 'Pays de masse') }]]);
    log(`${rows} lignes modifiées d'un coup (2 colonnes)`);
    let last = -1;
    await waitFor(async () => {
      const n = await inCible('Ville', 'Masse');
      if (n !== last) log(`modif de masse : ${n}/${rows} arrivées (${Math.round((Date.now() - t0) / 1000)} s)`);
      last = n;
      return n === rows;
    }, 'toutes les modifications arrivent', 1200000, 5000);
    const more = Math.round(rows / 2);
    const added = Array.from({ length: more }, (_, i) => makeRow(rows + i));
    const cols = Object.fromEntries(columnsOf(20).map(c => [c.id, added.map(r => r[c.id])]));
    const t1 = Date.now();
    await applyActions(p.src.doc, [['BulkAddRecord', 'Contacts', Array(more).fill(null), cols]]);
    log(`${more} lignes ajoutées d'un coup`);
    last = -1;
    await waitFor(async () => {
      const n = await count(p.dst.doc, p.dest);
      if (n !== last) log(`ajout de masse : ${n}/${rows + more} arrivées (${Math.round((Date.now() - t1) / 1000)} s)`);
      last = n;
      return n === rows + more;
    }, 'tous les ajouts arrivent', 1200000, 5000);
    const names = new Set((await records(p.dst.doc, p.dest)).map(r => r.Nom));
    assert.equal(names.size, rows + more, 'aucune ligne en double ni perdue');
  },

  // « Tout renvoyer » demandé plusieurs fois de suite, depuis deux pages SOURCE ouvertes en même temps : un seul
  // renvoi à la fois par document, la CIBLE garde exactement les lignes de la SOURCE, rien n'est doublé et rien
  // ne reste en file.
  async renvoisRepetes() {
    const rows = Number(process.env.ROWS || 4000);
    const p = await h.pair({ name: 'Renvois répétés', table: 'Contacts', columns: columnsOf(12), rows, makeRow, send: 'wait' });
    await follow(p, 'départ', n => n === rows, { timeout: 600000, every: 5000 });
    const other = await h.newView('source2');
    await h.login(other);
    await other.open(p.src.url);
    await other.widget().getByRole('tab', { name: 'Envoyer' }).click();
    await p.sv.open(p.src.url);
    await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    // Depuis la 0.12.3, « Tout renvoyer » part sans fenêtre (sauf un envoi long, qui se confirme) et se suit sur la carte :
    // « Renvoi terminé » quand cette page a envoyé, « Un autre renvoi est en cours » quand une autre page a la main
    // (le lot est alors noté et partira seul). Les deux réponses sont bonnes, le test relève laquelle vient.
    const again = async (view) => {
      await view.button('Tout renvoyer').click();
      const confirm = view.dialogButton('Envoyer');
      const which = await Promise.race([
        confirm.waitFor({ timeout: 180000 }).then(() => 'confirmation'),
        view.widget().getByText('Renvoi terminé').waitFor({ timeout: 180000 }).then(() => 'terminé'),
        view.widget().getByText('Un autre renvoi est en cours pour ce document').waitFor({ timeout: 180000 }).then(() => 'attente'),
      ]).catch(() => 'rien');
      log(`« Tout renvoyer » : ${which}`);
      if (which === 'confirmation') await confirm.click();
    };
    const t0 = Date.now();
    await Promise.all([again(p.sv), again(other)]);
    await sleep(2000);
    await again(p.sv).catch(e => log(`troisième demande : ${e.message.split('\n')[0]}`));
    log('trois demandes de renvoi total en deux pages');
    await waitFor(async () => {
      const [light, hooks] = await Promise.all([records(p.src.doc, 'Synchro'), webhooks(p.src.doc)]);
      const pending = light.filter(r => r.Synchro_Type === 'lot' && Number(r.Sync_Etat) > 0).length;
      const waiting = hooks.reduce((n, w) => n + (w.usage ? w.usage.numWaiting : 0), 0);
      log(`renvois : ${pending} lots à rattraper, ${waiting} envois en file (${Math.round((Date.now() - t0) / 1000)} s)`);
      return !pending && !waiting;
    }, 'les renvois se terminent', 900000, 10000);
    await sleep(20000);
    const cible = await records(p.dst.doc, p.dest);
    const names = new Set(cible.map(r => r.Nom));
    log(`après les renvois : CIBLE ${cible.length} lignes, ${names.size} noms distincts, ${Math.round((Date.now() - t0) / 1000)} s`);
    assert.equal(cible.length, rows, 'la CIBLE a exactement les lignes de la SOURCE');
    assert.equal(names.size, rows, 'aucune ligne en double');
    const hook = (await webhooks(p.src.doc))[0].usage;
    assert.ok(!(hook.lastHttpStatus >= 400), 'aucune erreur d\'envoi à la fin');
  },

  // Page CIBLE fermée pendant tout l'envoi : les lots s'entassent bruts dans le journal, puis la page
  // s'ouvre. Le dépliage de tout ce qui s'est entassé doit passer (c'est une seule écriture dans Grist
  // si rien ne la découpe), et la table doit arriver entière.
  async cibleFermee() {
    const rows = Number(process.env.ROWS || 30000);
    const cols = Number(process.env.COLS || 20);
    log(`cibleFermee : ${rows} lignes × ${cols} colonnes, page CIBLE fermée`);
    const p = await h.pair({
      name: `Cible fermée ${rows}x${cols}`, table: 'Contacts', columns: columnsOf(cols), rows, makeRow, send: 'start',
      afterAccept: async ({ dv }) => { await dv.page.goto('about:blank'); },
    });
    await p.sv.dialog().getByText('Lignes existantes envoyées').waitFor({ timeout: 3 * 3600 * 1000 });
    log('SOURCE : envoi terminé');
    await waitFor(async () => (await webhooks(p.src.doc)).every(w => !w.usage || !w.usage.numWaiting), 'file SOURCE vide', 600000, 5000);
    const parked = { n: await count(p.dst.doc, p.dest), j: await journalState(p) };
    log(`${parked.j.raw} lots bruts dans le journal CIBLE, ${parked.n} lignes recopiées : ouverture de la page CIBLE`);
    await p.dv.open(p.dst.url);
    await follow(p, 'cibleFermee (ouverte)', n => n === rows, { timeout: 1800000, every: 10000 });
    assert.equal(await count(p.dst.doc, p.dest), rows);
  },
};

const names = (process.env.ONLY || Object.keys(scenarios).join(',')).split(',');
let failed = false;
try {
  for (const name of names) {
    log(`=== ${name}`);
    await scenarios[name]();
    log(`=== ${name} : OK`);
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  if (h.problems.length) {
    console.error(`Erreurs du widget :\n${h.problems.join('\n')}`);
  }
  await h.close();
  if (proxy) await proxy.close();
}
process.exit(failed ? 1 : 0);
