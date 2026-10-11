/* PvPoke ranking search syntax, evaluated against league-specific engine metadata. */
(function(root){
  'use strict';
  const lower=value=>String(value??'').toLowerCase();
  function compile(query,data,teamMode=false){
    const groups=lower(query).trim().split(/\s*,\s*/).filter(Boolean).map(group=>group.split('&').map(term=>term.trim()));
    const families=new Map();
    for(const p of data.pokemon){
      if(p.family?.id!=null)for(const key of [p.speciesId,lower(p.speciesName),...(p.nicknames||[]).map(lower)])families.set(key,p.family.id);
    }
    function matches(term,record,row){
      if(!term)return false;
      if(term[0]==='!'&&term.length>1)return !matches(term.slice(1),record,row);
      if(term[0]==='+')return families.has(term.slice(1))&&families.get(term.slice(1))===record.familyId;
      if(term[0]==='@'){
        let text=term.slice(1),moves=record.moves.filter(m=>(row.moveset||[]).includes(m.id));
        if(text==='legacy'||text==='special')return moves.some(m=>(m.legacy||m.elite)&&!['RETURN','FRUSTRATION'].includes(m.id)||text==='special'&&['RETURN','FRUSTRATION'].includes(m.id));
        if(text==='beam')return moves.some(m=>['HYPER_BEAM','SOLAR_BEAM'].includes(m.id));
        if(text[0]==='1'||text[0]==='2'){moves=moves.filter(m=>m.kind===(text[0]==='1'?'fast':'charged'));text=text.slice(1);}
        return !!text&&moves.some(m=>m.name.startsWith(text)||m.type===text);
      }
      if(term==='xl')return record.xl;
      if(term==='hundo'||term==='4*')return record.hundo;
      if(term==='meta')return record.meta;
      if(term==='notes')return !!row.editorNotes?.trim();
      if(/^\d+k$/.test(term))return record.cost===Number(term.slice(0,-1))*1000;
      if(/^\d+km$/.test(term))return record.distance===Number(term.slice(0,-2));
      const region=data.pokemonRegions.find(r=>r.string===term||r.name===term);
      if(region)return record.dex>=region.dexStart&&record.dex<=region.dexEnd&&!(region.string==='gen1'&&record.tags.includes('alolan'));
      const traits=term==='bulky'?['bulky','extremely bulky']:term==='less bulky'?['less bulky','frail','glassy','glass cannon']:[term];
      return record.name.startsWith(term)||record.id.startsWith(term)||record.nicknames.includes(term)||record.types.includes(term)||record.tags.includes(term)||String(record.dex)===term||traits.some(t=>record.traits.includes(t));
    }
    if(teamMode)return (team,index)=>{
      if(!groups.length)return true;
      // Each positive term may match a different member; NOT excludes the whole team.
      function teamMatches(term){
        if(term[0]==='!'&&term.length>1)return !teamMatches(term.slice(1));
        if(term.startsWith('lead:')){
          const row=team[0],record=row&&index.get(row.speciesId);
          return !!record&&term.slice(5).split('/').every(part=>matches(part.trim(),record,row));
        }
        return team.some(row=>{const record=index.get(row.speciesId);return !!record&&matches(term,record,row);});
      }
      return groups.some(group=>group.every(teamMatches));
    };
    return (row,index)=>{
      if(!groups.length)return true;
      const record=index.get(row.speciesId);
      return !!record&&groups.some(group=>group.every(term=>matches(term,record,row)));
    };
  }
  root.PvPProSearch={compile,compileTeam:(query,data)=>compile(query,data,true)};
})(globalThis);
