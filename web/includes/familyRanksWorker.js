/* Keep exhaustive IV calculations off the UI thread. */
var perfTiming = false;
importScripts('calculate.js', 'pokeListObj.js', 'familyRanksCore.js');
const cache = new Map();
self.onmessage = function (event) {
  const {id, mon, league, floor, min, max, candidates} = event.data;
  try {
    if (!Object.prototype.hasOwnProperty.call(pokeListObj, mon)) throw new Error('Unknown Pokémon');
    const key = JSON.stringify([mon, league, floor, min, max]);
    if (!cache.has(key)) {
      const stats = pokeListObj[mon].split(',').slice(1, 4).map(Number);
      cache.set(key, calculate(...stats, floor, min, max, false, league, mon));
      // Bound memory during repeated searches and level-setting changes.
      if (cache.size > 48) cache.delete(cache.keys().next().value);
    }
    const ranks = cache.get(key);
    // Index once per request rather than scanning all 4096 spreads per candidate.
    const ratings = new Map();
    const keys = Object.keys(ranks).filter(key => key !== 'invalids' && Array.isArray(ranks[key]));
    const bestProduct = keys.length ? Number(keys[0].split('.')[0]) : 0;
    let rank = 0;
    for (const key of keys) for (const entry of ranks[key]) {
      rank++;
      const ivs = [entry.IVs.A, entry.IVs.D, entry.IVs.S];
      ratings.set(ivs.join('/'), {rank, total: ranks.numRanks, level: entry.L, cp: entry.CP,
        ivs, perfection: 100 * Number(key.split('.')[0]) / bestProduct});
    }
    const results = candidates.map(candidate => {
      const result = candidate.ivs ? ratings.get(candidate.ivs.join('/')) || null : FamilyRanks.summarize(ranks, null);
      return {key: candidate.key, ...FamilyRanks.checkCurrentLevel(candidate, result, pokeListObj, cpm)};
    });
    self.postMessage({id, mon, league, results});
  } catch (error) {
    self.postMessage({id, mon, league, error: error.message});
  }
};
