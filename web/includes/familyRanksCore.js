/* Family comparisons use the same ordering and stat product as calculate.js. */
(function (root) {
  'use strict';
  const leagues = [['500', 'Little'], ['1500', 'Great'], ['2500', 'Ultra'], ['ML', 'Master']];
  function family(mon, data) {
    if (!Object.prototype.hasOwnProperty.call(data, mon)) return [];
    return [...new Set([mon, ...data[mon].split(',').slice(4)])]
      .filter(name => Object.prototype.hasOwnProperty.call(data, name));
  }
  function eligible(source, target, ivs) {
    if (source !== 'Tyrogue' || !ivs) return true;
    const stat = {Hitmonlee: 0, Hitmonchan: 1, Hitmontop: 2}[target];
    return stat === undefined || ivs[stat] === Math.max(...ivs);
  }
  function summarize(ranks, ivs) {
    const keys = Object.keys(ranks).filter(key => Array.isArray(ranks[key]) && key !== 'invalids');
    if (!keys.length) return null;
    const bestProduct = Number(keys[0].split('.')[0]);
    let rank = 0;
    for (const key of keys) {
      for (const entry of ranks[key]) {
        rank++;
        if (!ivs || (entry.IVs.A === ivs[0] && entry.IVs.D === ivs[1] && entry.IVs.S === ivs[2])) {
          return {rank, total: ranks.numRanks, level: entry.L, cp: entry.CP,
            ivs: [entry.IVs.A, entry.IVs.D, entry.IVs.S],
            perfection: 100 * Number(key.split('.')[0]) / bestProduct};
        }
      }
    }
    return null;
  }
  function candidatesFromRows(rows, mon) {
    const candidates = [], errors = [];
    if (!rows.length) errors.push('Add at least one IV entry.');
    rows.forEach((values, index) => {
      if (![3, 4].includes(values.length) || values.slice(0, 3).some(value => String(value).trim() === '' ||
          !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 15)) {
        errors.push('Entry ' + (index + 1) + ': enter three integer IVs from 0 to 15.');
      } else {
        const currentCp = values[3] == null || String(values[3]).trim() === '' ? null : Number(values[3]);
        if (currentCp !== null && (!Number.isInteger(currentCp) || currentCp < 10)) {
          errors.push('Entry ' + (index + 1) + ': current CP must be an integer of at least 10.'); return;
        }
        candidates.push({key: index + 1, mon, ivs: values.slice(0, 3).map(Number), currentCp});
      }
    });
    const knownCPs = new Map();
    for (const candidate of candidates) if (candidate.currentCp !== null) {
      const spread = candidate.ivs.join('/');
      if (knownCPs.has(spread) && knownCPs.get(spread) !== candidate.currentCp)
        errors.push('Entry ' + candidate.key + ': this IV spread has conflicting CP values. Use one current CP for each unique spread.');
      knownCPs.set(spread, candidate.currentCp);
    }
    return {candidates, errors};
  }
  function markBest(rows) {
    const best = new Map();
    for (const row of rows) {
      if (!row.result) continue;
      const key = JSON.stringify([row.evo, row.league]);
      best.set(key, Math.min(best.get(key) || Infinity, row.result.rank));
    }
    return rows.map(row => ({...row, best: !!row.result && row.result.rank === best.get(JSON.stringify([row.evo, row.league]))}));
  }
  function uniqueCandidates(candidates) {
    const unique = new Map();
    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.mon, candidate.ivs]);
      if (unique.has(key)) {
        unique.get(key).entryKeys.push(candidate.key);
        if (candidate.currentCp != null) unique.get(key).currentCp = candidate.currentCp;
      }
      else unique.set(key, {...candidate, entryKeys: [candidate.key]});
    }
    return [...unique.values()];
  }
  function sortCandidates(candidates, results, column) {
    const ratings = new Map(results.filter(row => JSON.stringify([row.evo, row.league]) === column)
      .map(row => [row.candidate.key, row.result]));
    return candidates.slice().sort((a, b) => {
      const first = ratings.get(a.key), second = ratings.get(b.key);
      if (!!first !== !!second) return first ? -1 : 1;
      return (first && second ? first.rank - second.rank : 0) || a.key - b.key;
    });
  }
  const columnKey = (evo, league) => JSON.stringify([evo, league]);
  function percentile(result) {
    return result.total <= 1 ? 100 : 100 * (result.total - result.rank) / (result.total - 1);
  }
  function cpAtLevel(stats, ivs, level, multipliers) {
    const multiplier = multipliers[(level - 1) * 2];
    return Math.max(10, Math.floor((stats[0] + ivs[0]) * Math.sqrt(stats[1] + ivs[1]) *
      Math.sqrt(stats[2] + ivs[2]) * multiplier * multiplier / 10));
  }
  function inferLevels(candidate, data, multipliers) {
    if (candidate.currentCp == null) return {levels: []};
    const stats = data[candidate.mon].split(',').slice(1, 4).map(Number);
    const levels = [];
    // Current CP must be unboosted: the underlying Pokémon is level 1–50.
    for (let level = 1; level <= 50; level += 0.5)
      if (cpAtLevel(stats, candidate.ivs, level, multipliers) === candidate.currentCp) levels.push(level);
    return levels.length ? {levels} : {levels, error: 'Current CP does not match this base Pokémon and IV spread at levels 1–50. Check CP, form and IVs; remove any Best Buddy CP boost.'};
  }
  function checkCurrentLevel(candidate, result, data, multipliers) {
    const info = inferLevels(candidate, data, multipliers);
    if (info.error) return {...info, result: null};
    if (!result || !info.levels.length) return {...info, result};
    const lowest = info.levels[0], highest = info.levels[info.levels.length - 1];
    if (lowest > result.level) return {...info, result: null,
      error: 'Current level ' + (lowest === highest ? 'L' + lowest : 'L' + lowest + '–' + highest) +
        ' exceeds this option’s maximum L' + result.level + '; powering down is impossible.'};
    if (highest > result.level) return {...info, result: null,
      error: 'CP rounds to levels L' + lowest + '–' + highest + ', spanning this option’s maximum L' + result.level + '. Eligibility is uncertain; not recommended.'};
    return {...info, result};
  }
  // Rectangular Hungarian assignment: cover the most slots, then minimize total rank.
  function allocate(candidates, columns, results, choices = []) {
    const cells = new Map(results.filter(row => row.result).map(row =>
      [JSON.stringify([row.candidate.key, row.evo, row.league]), row]));
    const used = new Set(), fixed = new Map();
    for (const choice of choices) {
      const column = columnKey(choice.evo, choice.league);
      const candidate = candidates.find(item => item.ivs.join('/') === choice.ivs.join('/'));
      if (!columns.some(item => columnKey(item.evo, item.league) === column) || !candidate ||
          used.has(candidate.key) || fixed.has(column) ||
          !cells.has(JSON.stringify([candidate.key, choice.evo, choice.league]))) {
        throw new Error('A chosen cell is unavailable or reuses an IV spread or column.');
      }
      used.add(candidate.key); fixed.set(column, {candidate, ...choice, locked: true,
        result: cells.get(JSON.stringify([candidate.key, choice.evo, choice.league])).result});
    }
    const available = candidates.filter(item => !used.has(item.key));
    const slots = columns.filter(item => !fixed.has(columnKey(item.evo, item.league)));
    const m = slots.length, n = available.length + m;
    let maxRank = 1;
    for (const row of results) if (row.result) maxRank = Math.max(maxRank, row.result.rank);
    const penalty = (maxRank + 1) * (m + 1);
    const cost = (i, j) => {
      if (j >= available.length) return penalty;
      const row = cells.get(JSON.stringify([available[j].key, slots[i].evo, slots[i].league]));
      return row ? row.result.rank : penalty * (m + 1);
    };
    const u = Array(m + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = Array(n + 1).fill(Infinity), visited = Array(n + 1).fill(false);
      do {
        visited[j0] = true;
        const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= n; j++) if (!visited[j]) {
          const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= n; j++) {
          if (visited[j]) { u[p[j]] += delta; v[j] -= delta; }
          else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    for (let j = 1; j <= available.length; j++) if (p[j]) {
      const slot = slots[p[j] - 1], candidate = available[j - 1];
      const row = cells.get(JSON.stringify([candidate.key, slot.evo, slot.league]));
      if (row) { used.add(candidate.key); fixed.set(columnKey(slot.evo, slot.league), {...slot, candidate, result: row.result, locked: false}); }
    }
    const assignments = columns.map(slot => fixed.get(columnKey(slot.evo, slot.league))).filter(Boolean);
    return {assignments, unfilled: columns.filter(slot => !fixed.has(columnKey(slot.evo, slot.league))),
      unused: candidates.filter(item => !used.has(item.key)), totalRank: assignments.reduce((sum, item) => sum + item.result.rank, 0)};
  }
  function exportSearch(state) { return 'PVPIVS1:' + JSON.stringify(state); }
  function importSearch(text, data) {
    if (!text.trim().startsWith('PVPIVS1:')) throw new Error('Paste a search string beginning with PVPIVS1:.');
    let state;
    try { state = JSON.parse(text.trim().slice(8)); } catch (_) { throw new Error('The search string is not valid JSON.'); }
    if (!state || typeof state.mon !== 'string' || !Object.prototype.hasOwnProperty.call(data, state.mon)) throw new Error('The saved base Pokémon is unknown.');
    if (!Array.isArray(state.ivs) || !state.ivs.length || state.ivs.some(ivs => !Array.isArray(ivs) ||
        ivs.length !== 3 || ivs.some(value => !Number.isInteger(value) || value < 0 || value > 15))) throw new Error('The saved IV entries are invalid.');
    if (state.cps !== undefined && (!Array.isArray(state.cps) || state.cps.length !== state.ivs.length ||
        state.cps.some(value => value !== null && (!Number.isInteger(value) || value < 10)))) throw new Error('The saved current CP values are invalid.');
    const parsed = candidatesFromRows(state.ivs.map((ivs, i) => [...ivs, state.cps?.[i] ?? '']), state.mon);
    if (parsed.errors.length) throw new Error(parsed.errors.join(' '));
    if (!Number.isInteger(state.floor) || state.floor < 0 || state.floor > 15 ||
        ![state.min, state.max].every(value => Number.isFinite(value) && value >= 1 && value <= 51 && Number.isInteger(value * 2)) ||
        state.min > state.max) throw new Error('The saved calculation settings are invalid.');
    const members = family(state.mon, data), validLeagues = leagues.map(item => item[0]);
    if (!Array.isArray(state.columns) || !state.columns.length || state.columns.some(item => !Array.isArray(item) ||
        item.length !== 2 || !members.includes(item[0]) || !validLeagues.includes(item[1]))) throw new Error('The saved columns are invalid.');
    const columns = [...new Map(state.columns.map(item => [JSON.stringify(item), item])).values()];
    const choices = state.choices || [], chosenSpreads = new Set(), chosenColumns = new Set();
    if (!Array.isArray(choices)) throw new Error('The saved choices are invalid.');
    for (const choice of choices) {
      if (!choice || !Array.isArray(choice.ivs) || !state.ivs.some(ivs => JSON.stringify(ivs) === JSON.stringify(choice.ivs)) ||
          !columns.some(item => item[0] === choice.evo && item[1] === choice.league) ||
          choice.ivs.some(value => value < state.floor) || !eligible(state.mon, choice.evo, choice.ivs) ||
          chosenSpreads.has(JSON.stringify(choice.ivs)) || chosenColumns.has(columnKey(choice.evo, choice.league))) throw new Error('The saved choices reuse a spread or column, or refer to a missing entry.');
      chosenSpreads.add(JSON.stringify(choice.ivs)); chosenColumns.add(columnKey(choice.evo, choice.league));
    }
    return {...state, columns, choices};
  }
  root.FamilyRanks = {leagues, family, eligible, summarize, candidatesFromRows, markBest, uniqueCandidates, sortCandidates,
    columnKey, percentile, cpAtLevel, inferLevels, checkCurrentLevel, allocate, exportSearch, importSearch};
})(typeof self !== 'undefined' ? self : globalThis);
