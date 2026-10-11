(function(root) {
  'use strict';
  const leagues = [['1500', 'Great'], ['2500', 'Ultra'], ['10000', 'Master']];
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const index = (rows, key) => new Map(rows.map(row => [row[key], row]));
  const moveset = entry => Array.from({length:3}, (_, i) => entry?.moveset?.[i] || '');
  function moveUpdates(previous, current) {
    const old = index(previous, 'moveId'), result = new Map();
    for (const move of current) {
      const before = old.get(move.moveId);
      if (!before) { result.set(move.moveId, {kind:'new', details:'New to the game data'}); continue; }
      let buff = false, nerf = false; const details = [];
      for (const [field, direction] of [['power',1],['energyGain',1],['energy',-1],['turns',-1]]) {
        const from = field === 'turns' ? before.turns ?? (before.cooldown != null ? before.cooldown / 500 : null) : before[field] ?? 0;
        const to = field === 'turns' ? move.turns ?? (move.cooldown != null ? move.cooldown / 500 : null) : move[field] ?? 0;
        if (from == null || to == null) continue;
        if (from === to) continue;
        details.push(field + ': ' + from + ' → ' + to);
        if ((to-from)*direction > 0) buff = true; else nerf = true;
      }
      // Buff/debuff mechanics lack a universal better/worse direction.
      const mechanics = ['buffs','buffApplyChance','buffTarget','buffsSelf','buffsOpponent'];
      const reworked = mechanics.some(key => JSON.stringify(before[key]) !== JSON.stringify(move[key]));
      if (reworked) details.push('Buff/debuff mechanics changed');
      if (buff || nerf || reworked) result.set(move.moveId, {kind:reworked || (buff && nerf) ? 'rework' : buff ? 'buff' : 'nerf', details:details.join('; ')});
    }
    return result;
  }
  function buildReport(previous, current, cap, xlTable) {
    const oldRanks = index(previous.rankings, 'speciesId'), newRanks = index(current.rankings, 'speciesId');
    const oldPokemon = index(previous.pokemon, 'speciesId'), newPokemon = index(current.pokemon, 'speciesId');
    const moveMap = new Map([...previous.moves, ...current.moves].map(move => [move.moveId, move]));
    const updates = moveUpdates(previous.moves, current.moves);
    const name = id => moveMap.get(id)?.name || id.replaceAll('_',' ').toLowerCase().replace(/\b\w/g, c=>c.toUpperCase());
    const format = ids => ids.filter(Boolean).map(name).join(', ');
    const rows = [];
    const oldPositions = new Map(previous.rankings.map((entry,i)=>[entry.speciesId,i+1]));
    const newPositions = new Map(current.rankings.map((entry,i)=>[entry.speciesId,i+1]));
    for (const id of new Set([...newRanks.keys(), ...oldRanks.keys()])) {
      const before = oldRanks.get(id), after = newRanks.get(id);
      const pokemon = newPokemon.get(id) || oldPokemon.get(id) || {};
      const baseId = id.replace(/_shadow$/, '');
      const base = newPokemon.get(baseId) || pokemon;
      const oldBase = oldPokemon.get(baseId) || oldPokemon.get(id);
      const oldMoves = moveset(before), newMoves = moveset(after);
      const available = oldBase ? [...new Set([...(base.fastMoves || []), ...(base.chargedMoves || [])])].filter(move=>![...(oldBase.fastMoves || []), ...(oldBase.chargedMoves || [])].includes(move)).sort() : [];
      const buffs = newMoves.filter(move=>updates.get(move)?.kind==='buff');
      const nerfs = oldMoves.filter(move=>updates.get(move)?.kind==='nerf');
      const reworks = [...new Set([...oldMoves,...newMoves])].filter(move=>updates.get(move)?.kind==='rework');
      const changes = [];
      if (before && after) {
        if(oldMoves[0] !== newMoves[0]) changes.push((name(oldMoves[0]) || '(none)')+' → '+(name(newMoves[0]) || '(none)'));
        const removed = oldMoves.slice(1).filter(move=>move && !newMoves.slice(1).includes(move));
        const added = newMoves.slice(1).filter(move=>move && !oldMoves.slice(1).includes(move));
        for(let i=0;i<Math.max(removed.length,added.length);i++) changes.push((removed[i] ? name(removed[i]) : '(added)')+' → '+(added[i] ? name(added[i]) : '(removed)'));
      }
      const shadow = id.includes('shadow') || (pokemon.tags || []).includes('shadow');
      const level = pokemon.defaultIVs?.['cp'+cap]?.[0] ?? base.defaultIVs?.['cp'+cap]?.[0] ?? null;
      const xl = cap === '10000' || level == null ? null : level <= 40 ? 0 : xlTable[shadow?'shadow':'non_shadow']?.[String(level)] ?? null;
      const stats = pokemon.baseStats || {};
      const oldScore = Number.isFinite(before?.score) ? before.score : null, score = Number.isFinite(after?.score) ? after.score : null;
      const labels = [!before?'New entrant':!after?'Removed':null, buffs.length?'Buff':null, nerfs.length?'Nerf':null, available.length?'New moves ('+available.length+')':null,reworks.length?'Rework':null].filter(Boolean);
      rows.push({id, Pokemon:after?.speciesName || before?.speciesName || pokemon.speciesName || id,
        Status:!before?'New':!after?'Removed':'Compared', 'Old Rank':oldPositions.get(id) ?? null, Rank:newPositions.get(id) ?? null,
        'Old Score':oldScore, Score:score, Difference:oldScore != null && score != null ? round(score-oldScore) : null,
        'Fast Move':after ? name(newMoves[0]) : '', 'Charged Move 1':after ? name(newMoves[1]) : '', 'Charged Move 2':after ? name(newMoves[2]) : '',
        'Moveset Change':changes.join('\n'), Update:labels.join(' · '), 'Attack Availability':format(available), Buffs:format(buffs), Nerfs:format(nerfs), Rework:format(reworks),
        XL:xl, Level:level, Attack:stats.atk ?? null, Defense:stats.def ?? null, Stamina:stats.hp ?? null,
        Bulk:stats.def != null && stats.hp != null ? stats.def*stats.hp : null,
        'Stat Product':stats.atk != null && stats.def != null && stats.hp != null ? stats.atk*stats.def*stats.hp : null,
        Types:(pokemon.types || []).filter(type=>type!=='none').map(type=>type[0].toUpperCase()+type.slice(1)).join(', '),
        Shadow:shadow?'Yes':'No', moveStyles:newMoves.map((move,i)=>({kind:updates.get(move)?.kind || '',details:updates.get(move)?.details || '',added:!!before && !oldMoves.includes(move)}))});
    }
    const types = [];
    for(const type of [...new Set(rows.flatMap(row=>row.Types.split(', ').filter(Boolean)))].sort()) {
      const members=rows.filter(row=>row.Types.split(', ').includes(type));
      const matched=members.filter(row=>row.Difference != null);
      const mean=(items,key)=>{const values=items.map(item=>item[key]).filter(value=>value!=null);return values.length ? round(values.reduce((a,b)=>a+b,0)/values.length) : null;};
      const updateText=[...updates].filter(([id])=>moveMap.get(id)?.type===type.toLowerCase()).map(([id,info])=>name(id)+' ('+info.kind+')').join(', ');
      types.push({Type:type,Compared:matched.length,New:members.filter(row=>row.Status==='New').length,Removed:members.filter(row=>row.Status==='Removed').length,
        'Old Score':mean(matched,'Old Score'),Score:mean(matched,'Score'),Difference:mean(matched,'Difference'),Update:updateText});
    }
    return {rows,types};
  }
  root.PvPokeAnalysis = {leagues,moveUpdates,buildReport};
})(typeof self !== 'undefined' ? self : globalThis);
