(function(root) {
  'use strict';
  const cache = new Map();
  const api = 'https://api.github.com/repos/pvpoke/pvpoke/';
  async function json(url, signal, optional = false) {
    const mutable=url.startsWith(api);
    if (!mutable && cache.has(url)) return cache.get(url);
    const response = await fetch(url, {signal});
    if (optional && response.status===404) return null;
    if (!response.ok) {
      const limited = response.status===429 || (response.status===403 && response.headers.get('x-ratelimit-remaining')==='0');
      const reset = response.headers.get('x-ratelimit-reset');
      const message = limited ? 'GitHub’s public API rate limit was reached.'+(reset?' Try again after '+new Date(Number(reset)*1000).toLocaleTimeString()+'.':' Please try again later.') : 'GitHub returned '+response.status+' for '+new URL(url).pathname+'. Check the branch, cup and date.';
      throw new Error(message);
    }
    const data = await response.json();
    cache.set(url,data); if(cache.size>60) cache.delete(cache.keys().next().value);
    return data;
  }
  async function resolveSnapshot(snapshot,signal) {
    const query = new URLSearchParams({sha:snapshot.branch,per_page:'1'});
    if(snapshot.date) query.set('until',snapshot.date+'T23:59:59Z');
    const commits = await json(api+'commits?'+query,signal);
    if(!Array.isArray(commits) || !commits.length) throw new Error('No commits found for '+snapshot.branch+' on or before '+snapshot.date+'.');
    return {...snapshot,sha:commits[0].sha,committed:commits[0].commit.committer.date};
  }
  const rawUrl=(sha,path)=>'https://raw.githubusercontent.com/pvpoke/pvpoke/'+sha+'/'+path;
  async function loadSnapshot(snapshot,caps,signal) {
    const [pokemon,moves,...rankings] = await Promise.all([
      json(rawUrl(snapshot.sha,'src/data/gamemaster/pokemon.json'),signal),
      json(rawUrl(snapshot.sha,'src/data/gamemaster/moves.json'),signal),
      ...caps.map(cap=>json(rawUrl(snapshot.sha,'src/data/rankings/'+encodeURIComponent(snapshot.cup)+'/overall/rankings-'+cap+'.json'),signal,true))]);
    if(!Array.isArray(pokemon)||!Array.isArray(moves)||rankings.some(value=>value!==null&&!Array.isArray(value))) throw new Error('Unexpected PvPoke data format in '+snapshot.branch+'.');
    return {...snapshot,pokemon,moves,rankings:Object.fromEntries(caps.map((cap,i)=>[cap,rankings[i]]))};
  }
  async function branches(signal) {
    const names=[];
    for(let page=1;;page++) {
      const data=await json(api+'branches?'+new URLSearchParams({per_page:'100',page:String(page)}),signal);
      names.push(...data.map(item=>item.name));
      if(data.length<100)return names;
    }
  }
  async function cups(branch,signal) {
    const data=await json(api+'contents/src/data/rankings?'+new URLSearchParams({ref:branch}),signal);return data.filter(item=>item.type==='dir').map(item=>item.name);
  }
  root.PvPokeData = {resolveSnapshot,loadSnapshot,branches,cups};
})(typeof self !== 'undefined' ? self : globalThis);
