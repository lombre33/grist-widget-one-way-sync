// SOURCE : les clés `id_sync` des tables envoyées. Une ligne sans clé ne part pas, deux lignes de même clé
// n'en font qu'une chez les destinataires (voir logic/keys.js) : l'onglet Envoyer le compte (une requête,
// rien n'est lu en dehors des nombres) et propose de donner une clé neuve à ces lignes, puis les renvoie.
import { KEY_COL, ORDER_COL, chunk, nowS } from '../engine/logic/common.js';
import { fillKeyActions, missingSyncColumns, prepareSourceActions } from '../engine/logic/formulas.js';
import { keyCountSql, keyCounts, keyProblems, repairActions } from '../engine/logic/keys.js';
import { apply, fetchRows, querySql, readSchema, selectRows } from '../grist.js';
import { confirmDialog, el, run, smallButton } from '../ui.js';
import { t } from '../i18n.js';

// Comptes par table, relus au plus une fois par minute (l'onglet se redessine souvent) ; null : rien à signaler.
const CHECK_MS = 60000;
const checked = new Map(); // table -> { at, counts }

// Ce qui ne va pas dans `tables` : Map(table -> { rows, blank, dup, missing }) sans les tables en règle. `missing` :
// colonnes du widget (id_sync, MajLe, RecalculLe) qu'une personne a supprimées de la table ; sans elles les lignes ne
// partent plus. Une table absente n'est pas dite ici (voir exportDrift).
export async function checkKeys(tables) {
  const found = new Map();
  const schema = await readSchema();
  await Promise.all([...new Set(tables)].filter(table => schema.has(table)).map(async (table) => {
    const missing = missingSyncColumns(schema.columns(table));
    const was = checked.get(table);
    let counts = was && Date.now() - was.at < CHECK_MS ? was.counts : undefined;
    if (counts === undefined) {
      // Sans la colonne id_sync, SQLite lirait "id_sync" comme un texte, le même pour toutes les lignes.
      const sql = missing.includes(KEY_COL) ? null : keyCountSql(table);
      const rows = sql ? await querySql(sql) : null;
      if (!rows && !missing.length) return; // Grist refuse (table absente, droits) : rien n'est dit
      counts = rows ? keyCounts(rows[0]) : null;
      checked.set(table, { at: Date.now(), counts });
    }
    if (counts || missing.length) found.set(table, { rows: 0, blank: 0, dup: 0, ...counts, missing });
  }));
  return found;
}

// Toutes les lignes de la table avec leur clé (lecture légère, sinon la table entière).
const keyRows = async table => (await selectRows(table, [KEY_COL])) || fetchRows(table);

// Répare : remet les colonnes du widget supprimées (toutes les lignes reçoivent alors une clé neuve si id_sync
// manquait, et repartent), puis donne une clé neuve aux lignes sans clé et aux doubles (la plus ancienne garde la sienne), et les
// lignes touchées repartent comme après une modification. Rend le nombre de lignes renvoyées.
export async function repairKeys(table) {
  const missing = missingSyncColumns((await readSchema()).columns(table));
  if (missing.length) {
    await apply(prepareSourceActions(table, missing));
    checked.delete(table);
    if (missing.includes(KEY_COL)) {
      // Clés neuves pour toutes les lignes : elles repartent toutes comme après une modification (par tranches si la
      // table est grande, voir le rattrapage), sinon chez les destinataires rien ne porterait les nouvelles clés.
      const rows = await fetchRows(table);
      await apply(fillKeyActions(table, rows, () => crypto.randomUUID()));
      const now = nowS();
      await apply(chunk(rows.map(r => r.id)).map(ids => ['BulkUpdateRecord', table, ids, { [ORDER_COL]: ids.map(() => now) }]));
      return rows.length;
    }
  }
  const problems = keyProblems(await keyRows(table));
  if (!problems.touch.length) return 0;
  await apply(repairActions(table, problems, { newId: () => crypto.randomUUID(), now: nowS(), order: ORDER_COL }));
  checked.delete(table);
  return problems.touch.length;
}

// Avis d'un export : ce qui ne partira pas, pourquoi, et le bouton qui répare (`onDone` : redessin de l'onglet).
export function keysBlock(problems, onDone, { ownerOnly = false } = {}) {
  const out = el('div', { class: 'report' });
  const repair = smallButton(t('send.keys.repair'), 'edit', event => run(event.currentTarget, out, async () => {
    const lost = [...problems.values()].some(c => c.missing.length);
    const body = [lost ? t('send.keys.dialog.missing') : '', total(problems) ? t('send.keys.dialog.body', { n: total(problems) }) : ''].filter(Boolean).join(' ');
    if (!(await confirmDialog({ title: t('send.keys.dialog.title'), body, confirmLabel: t('send.keys.repair') }))) return;
    for (const table of problems.keys()) await repairKeys(table);
    await onDone();
  }), { kind: 'btn-primary', disabled: ownerOnly });
  return el('div', { class: 'msg msg-warn', 'data-keys': '' },
    el('strong', {}, t('send.keys.title')),
    el('p', { class: 'small' }, t('send.keys.help')),
    el('ul', { class: 'small' }, [...problems].flatMap(([table, c]) => [
      c.missing.length ? el('li', {}, t('send.keys.missing', { table, cols: c.missing.join(', '), n: c.missing.length })) : null,
      c.blank || c.dup ? el('li', {}, t('send.keys.line', { table, blank: c.blank, dup: c.dup })) : null,
    ].filter(Boolean))),
    el('div', { class: 'person-actions' }, repair), out);
}

const total = problems => [...problems.values()].reduce((n, c) => n + c.blank + c.dup, 0);

