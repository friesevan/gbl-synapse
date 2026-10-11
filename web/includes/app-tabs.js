// App navigation for familyRanks.html: three nested tab levels with one router.
//   PvPIV Pro · PvPoke Pro · Meta Extractor            (#appTabs)
//   PvPoke Pro › Pokémon Rankings · Team Rankings      (#proSubTabs)
//   Pokémon Rankings › Current · Historical            (#proRankModes)
// URLs: ?app=pro&view=current|historical|teams. Old links keep working: ?app=analysis (the former
// PvPoke Analysis tab) opens Historical, ?view=rank|lab opens Current (Moveset Lab was removed) and
// ?view=neural opens Team Rankings. The last PvPoke Pro view is remembered in this browser.
// Views listen for `pvp-view-change` (detail: {app, proView, mode}); `pvp-tab-change` (detail: app)
// and `neural-open` are kept for older listeners.
(function(root) {
  'use strict';
  const apps = ['iv', 'pro', 'meta'], proViews = ['rankings', 'teams'], modes = ['current', 'historical'];
  const storageKey = 'gbl-synapse.pro-view';
  const viewAliases = {
    current:['rankings','current'], rank:['rankings','current'], rankings:['rankings','current'], lab:['rankings','current'],
    historical:['rankings','historical'], history:['rankings','historical'], analysis:['rankings','historical'],
    teams:['teams',null], team:['teams',null], neural:['teams',null]
  };
  function resolve(search, remembered = {}) {
    const params = new URLSearchParams(search || '');
    let app = String(params.get('app') || 'iv').toLowerCase(), view = String(params.get('view') || '').toLowerCase();
    if (app === 'analysis') { app = 'pro'; view = 'historical'; }
    if (!apps.includes(app)) app = 'iv';
    const route = {app, proView:proViews.includes(remembered?.proView) ? remembered.proView : 'rankings', mode:modes.includes(remembered?.mode) ? remembered.mode : 'current'};
    const alias = app === 'pro' && Object.hasOwn(viewAliases, view) ? viewAliases[view] : null;
    if (alias) { route.proView = alias[0]; if (alias[1]) route.mode = alias[1]; }
    return route;
  }
  const viewName = route => route.proView === 'teams' ? 'teams' : route.mode;
  // Canonical query string for a route; unrelated parameters are kept.
  function search(route, current = '') {
    const params = new URLSearchParams(current);
    params.delete('app'); params.delete('view');
    if (route.app !== 'iv') params.set('app', route.app);
    if (route.app === 'pro') params.set('view', viewName(route));
    const text = params.toString();
    return text ? '?' + text : '';
  }
  function header(route) {
    if (route.app === 'iv') return {title:'PvP IV Pro', documentTitle:'PvP IV Pro', subtitle:'Modification of PvP IVs', href:'https://pvpivs.com/', intro:'Compare your Pokémon. Plan your best evolutions.'};
    if (route.app === 'meta') return {title:'Meta Extractor', documentTitle:'Meta Extractor', subtitle:'Built from PoGo Recorder · Battle data powered by you', href:'https://github.com/evanjfries/PoGoAnalyzer', intro:'Review your battles. Reveal the live meta.'};
    if (route.proView === 'teams') return {title:'PvPoke Pro', documentTitle:'Team Rankings · PvPoke Pro', subtitle:'Powered by PvPoke', href:'https://pvpoke.com/', intro:'Find the strongest three-Pokémon teams. Replay every saved battle.'};
    if (route.mode === 'historical') return {title:'PvPoke Pro', documentTitle:'Historical Rankings · PvPoke Pro', subtitle:'Based on PvPokeAnalysis · Data from PvPoke', href:'https://github.com/friesevan/PvPokeAnalysis', intro:'Explore ranking changes across updates, branches and cups.'};
    return {title:'PvPoke Pro', documentTitle:'Pokémon Rankings · PvPoke Pro', subtitle:'Powered by PvPoke', href:'https://pvpoke.com/', intro:'Explore the meta. Build your roster. Generate custom rankings.'};
  }
  // Roving focus for a horizontal tablist: arrows wrap, Home/End jump. -1 means "not a tab key".
  function nextIndex(key, index, count) {
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    if (key === 'ArrowRight') return (index + 1) % count;
    if (key === 'ArrowLeft') return (index + count - 1) % count;
    return -1;
  }
  const api = {resolve, search, header, nextIndex, apps, proViews, modes, storageKey};
  root.PvPTabs = api;
  if (typeof document === 'undefined' || !document.getElementById('appTabs')) return;

  const $ = id => document.getElementById(id);
  const levels = [
    {nav:'appTabs', key:'app', items:[['ivTab','ivPanel','iv'], ['proTab','proPanel','pro'], ['metaTab','metaPanel','meta']]},
    {nav:'proSubTabs', key:'proView', items:[['proRankTab','proRankingsPanel','rankings'], ['proNeuralTab','proNeuralPanel','teams']]},
    {nav:'proRankModes', key:'mode', items:[['proCurrentTab','proCurrentPanel','current'], ['proHistoricalTab','proHistoricalPanel','historical']]}
  ];
  let route = null;
  function remembered() { try { return JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { return {}; } }
  function remember(value) { try { localStorage.setItem(storageKey, JSON.stringify({proView:value.proView, mode:value.mode})); } catch { /* storage unavailable: nothing to remember */ } }
  function show(next) {
    const previous = route;
    route = {...(route || resolve('')), ...next};
    for (const level of levels) for (const [tab, panel, value] of level.items) {
      const on = route[level.key] === value;
      $(tab).setAttribute('aria-selected', String(on)); $(tab).tabIndex = on ? 0 : -1; $(panel).hidden = !on;
    }
    const head = header(route);
    $('appTitle').textContent = head.title; document.title = head.documentTitle;
    $('appSubtitle').textContent = head.subtitle; $('appSubtitle').href = head.href; $('appIntro').textContent = head.intro;
    if (route.app === 'pro') remember(route);
    try {
      const url = new URL(location.href), query = search(route, url.search);
      if (url.search !== query) { url.search = query; history.replaceState(history.state, '', url); }
    } catch { /* sandboxed viewers may block history updates */ }
    if (!previous || previous.app !== route.app) document.dispatchEvent(new CustomEvent('pvp-tab-change', {detail:route.app}));
    document.dispatchEvent(new CustomEvent('pvp-view-change', {detail:{...route}}));
    if (route.app === 'pro' && route.proView === 'teams') document.dispatchEvent(new Event('neural-open'));
  }
  for (const level of levels) {
    for (const [tab, , value] of level.items) $(tab).addEventListener('click', () => show({[level.key]:value}));
    $(level.nav).addEventListener('keydown', event => {
      const active = level.items.findIndex(([tab]) => $(tab).getAttribute('aria-selected') === 'true');
      const index = nextIndex(event.key, Math.max(0, active), level.items.length);
      if (index < 0) return;
      event.preventDefault();
      show({[level.key]:level.items[index][2]});
      $(level.items[index][0]).focus();
    });
  }
  api.show = next => show(next);
  api.current = () => ({...route});
  show(resolve(location.search, remembered()));
})(typeof self !== 'undefined' ? self : globalThis);
