// Adapts the app to the Claude artifact viewer:
// - GitHub requests (Historical rankings and snapshot comparison columns) go through the viewer's GitHub connector.
// - PvPoke Pro data files load live from PvPoke's latest commit, falling back
//   to the bundled snapshot when the connector can't deliver them.
// - File downloads go through the viewer's save prompt.
(function () {
  'use strict';

  const SERVER = 'GitHub', OWNER = 'pvpoke', REPO = 'pvpoke', BRANCH = 'master';
  const BUNDLED_SHA = 'f627e89e53c0c7b903fff097df7a0ad0ac95decc';
  const GROUPS = {500: 'littlegeneral', 1500: 'great', 2500: 'ultra', 10000: 'master'};
  const CATEGORIES = ['overall', 'leads', 'closers', 'switches', 'chargers', 'attackers'];
  const MODE_KEY = 'pvp-iv-pro:data-source';
  const nativeFetch = window.fetch.bind(window);
  const use = name => (window.claude && window.claude.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null));
  const mcpReady = use('mcp'), downloadsReady = use('downloads');

  let preferBundled = false;
  try { preferBundled = localStorage.getItem(MODE_KEY) === 'bundled'; } catch (e) { /* storage blocked */ }

  // ---------- Connector calls ----------

  const MESSAGES = {
    server_not_connected: 'Connect GitHub in claude.ai Settings → Connectors to load live PvPoke data.',
    needs_reauth: 'Your GitHub connection expired. Reconnect GitHub in claude.ai Settings → Connectors.',
    not_in_manifest: 'GitHub access is off for this page. Turn it on from the page’s Permissions menu, then reload.',
    selection_required: 'Choose which GitHub connector this page should use, then reload.',
    approval_required: 'This page needs your approval to read from GitHub. Reload and choose Allow.',
    blocked_by_policy: 'Your organization’s policy blocks GitHub for this page.',
    server_unavailable: 'GitHub didn’t respond. Try again in a minute.',
  };
  function connectorError(error) {
    const code = error && error.code;
    const message = MESSAGES[code] || (code === 'tool_error' ? 'GitHub reported: ' + (error.message || 'an error') : 'Live GitHub data isn’t available right now' + (error && error.message ? ': ' + error.message : '.'));
    const wrapped = new Error(message);
    wrapped.code = code;
    return wrapped;
  }

  async function call(tool, input) {
    const mcp = await mcpReady;
    if (!mcp) throw Object.assign(new Error('Live GitHub data isn’t available in this view.'), {code: 'unavailable'});
    for (let attempt = 0; ; attempt++) {
      try {
        return await mcp.callTool(SERVER, tool, Object.assign({owner: OWNER, repo: REPO}, input));
      } catch (error) {
        if (attempt === 0 && error && error.retryable) {
          await new Promise(r => setTimeout(r, (error.retryAfterMs || 800) + Math.random() * 600));
          continue;
        }
        throw connectorError(error);
      }
    }
  }

  async function listing(tool, input) {
    const result = await call(tool, input);
    if (Array.isArray(result.payload)) return result.payload;
    throw new Error('GitHub returned an unexpected response for ' + tool + '.');
  }

  // File text from get_file_contents: the content arrives as an embedded resource.
  async function fileText(path, sha) {
    const result = await call('get_file_contents', {path, sha});
    for (const block of result.content || []) {
      if (block.type === 'resource' && block.resource && typeof block.resource.text === 'string') return block.resource.text;
    }
    throw new Error('GitHub didn’t return the contents of ' + path + '. The file may be too large for the connector.');
  }

  // ---------- Cache (IndexedDB, keyed by commit + path) ----------

  const idb = new Promise(resolve => {
    try {
      const open = indexedDB.open('pvp-iv-pro-live', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('files');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  async function cacheGet(key) {
    const db = await idb; if (!db) return null;
    return new Promise(resolve => {
      try { const req = db.transaction('files').objectStore('files').get(key); req.onsuccess = () => resolve(req.result || null); req.onerror = () => resolve(null); }
      catch (e) { resolve(null); }
    });
  }
  async function cachePut(key, value) {
    const db = await idb; if (!db) return;
    try { db.transaction('files', 'readwrite').objectStore('files').put(value, key); } catch (e) { /* quota or blocked */ }
  }
  async function cachePrune(keepSha) {
    const db = await idb; if (!db) return;
    try {
      const store = db.transaction('files', 'readwrite').objectStore('files');
      const req = store.getAllKeys();
      req.onsuccess = () => req.result.forEach(key => { if (!String(key).startsWith(keepSha + '/')) store.delete(key); });
    } catch (e) { /* ignore */ }
  }

  async function liveFile(sha, path) {
    const key = sha + '/' + path, cached = await cacheGet(key);
    if (cached) return cached;
    const text = await fileText(path, sha);
    JSON.parse(text); // reject truncated or non-JSON results before caching
    cachePut(key, text);
    return text;
  }

  // ---------- Live PvPoke snapshot for the Pro tab ----------

  const state = {mode: preferBundled ? 'bundled' : 'resolving', sha: null, date: null, reason: preferBundled ? 'You chose the bundled snapshot.' : '', fallbacks: new Set()};
  let commitPromise = null;
  function latestCommit() {
    return commitPromise ||= listing('list_commits', {sha: BRANCH, perPage: 1, fields: ['sha', 'commit']}).then(rows => {
      if (!rows.length) throw new Error('PvPoke has no commits on ' + BRANCH + '.');
      state.sha = rows[0].sha; state.date = rows[0].commit && rows[0].commit.committer && rows[0].commit.committer.date;
      cachePrune(state.sha);
      return state.sha;
    });
  }

  function proSource(file) {
    let m;
    if (file === 'gamemaster.json') return {kind: 'gamemaster', path: 'src/data/gamemaster.min.json'};
    if ((m = /^league-(\d+)\.json$/.exec(file)) && GROUPS[m[1]]) return {kind: 'league', cp: m[1]};
    if ((m = /^meta-(\d+)\.json$/.exec(file)) && GROUPS[m[1]]) return {kind: 'meta', path: 'src/data/groups/' + GROUPS[m[1]] + '.json'};
    if ((m = /^overrides-(\d+)\.json$/.exec(file)) && GROUPS[m[1]]) return {kind: 'overrides', path: 'src/data/overrides/all/' + m[1] + '.json'};
    return null;
  }

  // The gamemaster decides the mode: if it can't load live, every Pro file stays bundled
  // so rankings and Pokémon data always come from the same commit.
  let gamemasterPromise = null;
  function liveGamemaster() {
    return gamemasterPromise ||= latestCommit().then(sha => liveFile(sha, 'src/data/gamemaster.min.json'));
  }

  async function liveProFile(source) {
    await liveGamemaster();
    const sha = state.sha;
    if (source.kind === 'gamemaster') return liveGamemaster();
    if (source.kind === 'league') {
      const parts = await Promise.all(CATEGORIES.map(c => liveFile(sha, 'src/data/rankings/all/' + c + '/rankings-' + source.cp + '.json')));
      return JSON.stringify(Object.fromEntries(CATEGORIES.map((c, i) => [c, JSON.parse(parts[i])])));
    }
    return liveFile(sha, source.path);
  }

  async function proFetch(input, init, file) {
    const source = proSource(file);
    if (!source || preferBundled || state.mode === 'bundled') return nativeFetch(input, init);
    try {
      const text = await liveProFile(source);
      if (state.mode !== 'live') { state.mode = 'live'; render(); }
      return jsonResponse(text);
    } catch (error) {
      if (source.kind === 'gamemaster' || state.mode !== 'live') { state.mode = 'bundled'; state.reason = error.message; }
      else state.fallbacks.add(file.replace('.json', ''));
      console.warn('Using bundled ' + file + ':', error.message);
      render();
      return nativeFetch(input, init);
    }
  }

  // ---------- GitHub REST URLs used by Historical rankings and snapshot comparisons ----------

  const API = 'https://api.github.com/repos/pvpoke/pvpoke/', RAW = 'https://raw.githubusercontent.com/pvpoke/pvpoke/';
  function jsonResponse(text, status) {
    return new Response(typeof text === 'string' ? text : JSON.stringify(text), {status: status || 200, headers: {'content-type': 'application/json'}});
  }
  async function githubFetch(url) {
    try {
      if (url.startsWith(RAW)) {
        const rest = url.slice(RAW.length), slash = rest.indexOf('/');
        const sha = rest.slice(0, slash), path = decodeURIComponent(rest.slice(slash + 1));
        try { return jsonResponse(await liveFile(sha, path)); }
        catch (error) {
          if (error.code === 'tool_error' && /not found|404/i.test(error.message)) return jsonResponse('{"message":"Not Found"}', 404);
          throw error;
        }
      }
      const u = new URL(url), endpoint = u.pathname.replace('/repos/pvpoke/pvpoke/', ''), q = u.searchParams;
      if (endpoint === 'commits') {
        const input = {sha: q.get('sha') || BRANCH, perPage: Number(q.get('per_page') || 1), fields: ['sha', 'commit']};
        if (q.get('until')) input.until = q.get('until');
        return jsonResponse(await listing('list_commits', input));
      }
      if (endpoint === 'branches') {
        return jsonResponse(await listing('list_branches', {perPage: Number(q.get('per_page') || 100), page: Number(q.get('page') || 1)}));
      }
      if (endpoint.startsWith('contents/')) {
        const input = {path: decodeURIComponent(endpoint.slice('contents/'.length)), fields: ['name', 'type']};
        if (q.get('ref')) input.ref = 'refs/heads/' + q.get('ref');
        return jsonResponse(await listing('get_file_contents', input));
      }
      throw new Error('This GitHub request isn’t supported inside the artifact: ' + endpoint);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    if (url) {
      if (url.startsWith(API) || url.startsWith(RAW)) return githubFetch(url);
      const m = /(?:^|\/)includes\/pro\/data\/([a-z0-9-]+\.json)$/.exec(url.split('?')[0]);
      if (m) return proFetch(input, init, m[1]);
    }
    return nativeFetch(input, init);
  };

  // ---------- Data-source bar ----------

  let bar = null;
  function shortSha(sha) { return sha ? sha.slice(0, 7) : ''; }
  function render() {
    if (!bar) return;
    const text = bar.querySelector('.data-source-text'), toggle = bar.querySelector('button');
    bar.dataset.state = state.mode;
    if (state.mode === 'live') {
      const date = state.date ? new Date(state.date).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'}) : '';
      text.textContent = 'Live PvPoke data · ' + BRANCH + ' @ ' + shortSha(state.sha) + (date ? ' · ' + date : '') +
        (state.fallbacks.size ? ' · bundled for ' + [...state.fallbacks].join(', ') : '');
    } else if (state.mode === 'bundled') {
      text.textContent = 'Bundled PvPoke snapshot @ ' + shortSha(BUNDLED_SHA) + (state.reason ? ' · ' + state.reason : '');
    } else {
      text.textContent = 'Live PvPoke data loads from GitHub when you open a PvPoke tab.';
    }
    toggle.textContent = preferBundled ? 'Use live data' : 'Use bundled snapshot';
    const link = document.querySelector('a[href*="pvpoke/pvpoke/tree/"]');
    if (link && state.mode === 'live' && state.sha) { link.href = 'https://github.com/pvpoke/pvpoke/tree/' + state.sha; link.textContent = 'PvPoke · ' + shortSha(state.sha); }
  }
  function mountBar() {
    const header = document.querySelector('.site-header');
    if (!header || bar) return;
    bar = document.createElement('div');
    bar.className = 'data-source';
    bar.innerHTML = '<span class="data-source-dot" aria-hidden="true"></span><span class="data-source-text" role="status"></span><button type="button" class="secondary" id="dataSourceToggle"></button>';
    bar.querySelector('button').onclick = () => {
      try { localStorage.setItem(MODE_KEY, preferBundled ? 'live' : 'bundled'); } catch (e) { /* storage blocked */ }
      location.reload();
    };
    header.after(bar);
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBar); else mountBar();

  // ---------- Downloads ----------

  async function saveLink(link) {
    const downloads = await downloadsReady;
    if (!downloads) return;
    const name = link.getAttribute('download') || link.href.split('/').pop().split('?')[0] || 'download.json';
    try {
      const blob = await (await nativeFetch(link.href)).blob();
      await downloads.save({filename: name, data: blob});
    } catch (error) {
      if (error && error.code !== 'declined') console.warn('Download failed:', error.message || error);
    }
  }
  document.addEventListener('click', event => {
    const link = event.target.closest && event.target.closest('a[download]');
    if (!link) return;
    event.preventDefault();
    saveLink(link);
  }, true);
  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download') && !this.isConnected) { saveLink(this); return; }
    return nativeClick.call(this);
  };

  for (const method of ['replaceState', 'pushState']) {
    const original = history[method].bind(history);
    history[method] = function () { try { return original.apply(null, arguments); } catch (e) { /* sandboxed */ } };
  }
})();
