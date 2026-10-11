// Site colour theme: System (follows prefers-color-scheme), Light or Dark, remembered in this browser.
// Load it synchronously in <head>, before the stylesheets, so a stored choice applies before first paint:
//   <script src="includes/theme.js"></script>
// Every colour is a CSS token on :root (familyRanks.css): light by default, dark under
// @media (prefers-color-scheme: dark) unless [data-theme="light"], and under [data-theme="dark"].
// This script only sets or clears data-theme on <html>. A host (the claude.ai artifact viewer) may stamp
// data-theme itself; "System" then keeps the host's value, and an explicit Light or Dark wins.
// Toggle: any element with [data-theme-toggle] containing buttons with data-theme-choice="system|light|dark".
// Charts use the tokens through CSS variables, so they recolour by themselves; anything that resolves a
// colour in script can listen for document 'gbl-theme-change' (detail: {preference, theme}).
(function(root) {
  'use strict';
  const storageKey = 'gbl-synapse.theme', choices = ['system', 'light', 'dark'], themes = ['light', 'dark'];
  const valid = v => choices.includes(v) ? v : 'system';
  // data-theme value for a preference: explicit choices win; System leaves the host's stamp (or none).
  const attribute = (preference, host) => themes.includes(preference) ? preference : themes.includes(host) ? host : null;
  const effective = (preference, host, systemDark) => attribute(preference, host) || (systemDark ? 'dark' : 'light');
  const api = {storageKey, choices, attribute, effective, valid};
  root.GblTheme = api;
  const doc = root.document, html = doc && doc.documentElement;
  if (!html || typeof html.getAttribute !== 'function') return;

  let storage = null;
  try { storage = root.localStorage; } catch (e) { /* storage blocked */ }
  const read = () => { try { return valid(storage && storage.getItem(storageKey)); } catch (e) { return 'system'; } };
  const write = v => { try { if (storage) storage.setItem(storageKey, v); } catch (e) { /* storage blocked */ } };
  const media = typeof root.matchMedia === 'function' ? root.matchMedia('(prefers-color-scheme: dark)') : null;
  const systemDark = () => !!(media && media.matches);

  let preference = read(), host = html.getAttribute('data-theme'), applied, last, reapplied = 0;
  function current() { return effective(preference, host, systemDark()); }
  function apply() {
    const value = attribute(preference, host);
    applied = value;
    if (value) { if (html.getAttribute('data-theme') !== value) html.setAttribute('data-theme', value); }
    else if (html.hasAttribute('data-theme')) html.removeAttribute('data-theme');
  }
  function announce() {
    const theme = current();
    syncToggles();
    if (theme === last) return;
    last = theme;
    if (typeof root.CustomEvent === 'function' && doc.dispatchEvent) doc.dispatchEvent(new root.CustomEvent('gbl-theme-change', {detail: {preference, theme}}));
  }
  function set(next) {
    preference = valid(next);
    write(preference);
    apply();
    announce();
  }
  function syncToggles() {
    if (!doc.querySelectorAll) return;
    const theme = current();
    for (const group of doc.querySelectorAll('[data-theme-toggle]')) {
      group.dataset.effective = theme;
      for (const button of group.querySelectorAll('[data-theme-choice]')) {
        const choice = button.getAttribute('data-theme-choice');
        button.setAttribute('aria-pressed', String(choice === preference));
        if (choice === 'system') button.title = `Follow the ${host ? 'page host' : 'device'} setting (currently ${theme === 'dark' ? 'Dark' : 'Light'})`;
      }
    }
  }
  function bind() {
    if (!doc.querySelectorAll) return;
    for (const group of doc.querySelectorAll('[data-theme-toggle]')) {
      if (group.dataset.bound) continue;
      group.dataset.bound = '1';
      group.addEventListener('click', event => {
        const button = event.target && event.target.closest ? event.target.closest('[data-theme-choice]') : null;
        if (button && group.contains(button)) set(button.getAttribute('data-theme-choice'));
      });
    }
    syncToggles();
  }

  apply();
  last = current();
  if (media) {
    const onSystem = () => announce();
    if (media.addEventListener) media.addEventListener('change', onSystem); else if (media.addListener) media.addListener(onSystem);
  }
  // A host changing data-theme after load (the artifact viewer following its own theme switch).
  if (typeof root.MutationObserver === 'function') {
    new root.MutationObserver(() => {
      const now = html.getAttribute('data-theme');
      if (now === applied) return;
      host = now;
      if (themes.includes(preference) && now !== preference && reapplied++ < 20) apply(); else applied = now;
      announce();
    }).observe(html, {attributes: true, attributeFilter: ['data-theme']});
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind); else bind();
  // Another tab changed the preference.
  if (root.addEventListener) root.addEventListener('storage', event => { if (event.key === storageKey) { preference = valid(event.newValue); apply(); announce(); } });
  api.set = set; api.bind = bind;
  Object.defineProperties(api, {preference: {get: () => preference}, theme: {get: current}});
})(typeof window === 'undefined' ? globalThis : window);
