// Démarrage : thème et langue, chargement de l'API des widgets depuis l'instance Grist, choix de
// l'onglet, Réglages.
import { GRIST_ORIGINS, VERSION } from './config.js';
import { CONFIG_TABLE, RECIPIENTS_TABLE } from './core.js';
import { LANG, t, translatePage } from './i18n.js';
import { applyTheme, readPref, writePref } from './prefs.js';
import { hasTable } from './tables.js';
import { copyField, el, message, openModal } from './ui.js';
import { renderSource } from './source.js';
import { consolidateAll, renderTarget, startAutoConsolidation } from './target.js';

const $ = id => document.getElementById(id);

// L'API des widgets vient de l'instance qui affiche le widget, si elle est dans la liste ; sinon
// de la première instance de la liste. Jamais d'une adresse choisie par la page qui encadre.
function loadPluginApi() {
  let origin = GRIST_ORIGINS[0];
  try {
    const parent = new URL(document.referrer).origin;
    if (GRIST_ORIGINS.includes(parent)) origin = parent;
  } catch (e) { /* pas de référent : instance par défaut */ }
  return new Promise((resolve, reject) => {
    const script = el('script', { src: `${origin}/grist-plugin-api.js` });
    script.onload = resolve;
    script.onerror = () => reject(new Error(`${origin}/grist-plugin-api.js`));
    document.head.append(script);
  });
}

function showScreen(...nodes) {
  $('main').replaceChildren(...nodes.filter(Boolean));
}

function showStartProblem(text, withAddress) {
  $('tabs').classList.add('hidden');
  const address = location.origin + location.pathname.replace(/index\.html$/, '');
  showScreen(message('warn', text), withAddress ? copyField(address) : null);
}

async function select(tab) {
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  const view = el('div', { class: 'view' });
  showScreen(view);
  await (tab === 'send' ? renderSource(view) : renderTarget(view));
}

function showHome() {
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', 'false');
  const tile = (tab, title, desc) => el('button', { class: 'tile', type: 'button', onclick: () => select(tab) },
    el('span', { class: 'tile-title' }, title), el('span', { class: 'tile-desc' }, desc));
  showScreen(el('h1', { class: 'home-title' }, t('home.title')),
    el('div', { class: 'tiles' }, tile('send', t('home.send'), t('home.send.desc')), tile('receive', t('home.receive'), t('home.receive.desc'))));
}

function openSettings() {
  const radios = (name, values, current, onPick) => el('div', { class: 'radios', role: 'radiogroup' }, values.map(([value, label]) =>
    el('label', {}, el('input', { type: 'radio', name, value, checked: value === current, onchange: () => onPick(value) }), label)));
  openModal({
    title: t('settings.title'), width: 400,
    body: el('div', { class: 'form' },
      el('h3', {}, t('settings.lang')),
      radios('lang', [['fr', 'Français'], ['en', 'English']], LANG, (lang) => { if (writePref('lang', lang)) location.reload(); }),
      el('h3', {}, t('settings.theme')),
      radios('theme', [['system', t('settings.theme.system')], ['light', t('settings.theme.light')], ['dark', t('settings.theme.dark')]],
        readPref('theme') || 'system', (theme) => { writePref('theme', theme); applyTheme(); }),
      el('h3', {}, t('settings.credits')),
      el('p', { class: 'small' }, t('settings.credits.text', { version: VERSION }))),
  });
}

async function start() {
  applyTheme();
  translatePage();
  $('settings').addEventListener('click', openSettings);
  for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => select(button.dataset.tab));

  if (window.parent === window) return showStartProblem(t('start.outside'), true);
  try {
    await loadPluginApi();
  } catch (e) {
    return showStartProblem(t('error.generic', { detail: e.message }), false);
  }
  grist.ready({ requiredAccess: 'full' });
  try {
    await Promise.race([grist.docApi.fetchTable('_grist_Tables'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))]);
  } catch (e) {
    return showStartProblem(t('start.access'), false);
  }

  const receiving = await hasTable(CONFIG_TABLE);
  startAutoConsolidation();
  if (receiving) { await select('receive'); consolidateAll(); } else if (await hasTable(RECIPIENTS_TABLE)) await select('send'); else showHome();
}

start();
