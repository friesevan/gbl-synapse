'use strict';
const modern=s=>/^neural-team-search-v[234]$/.test(s.config?.version||'');
const factor=s=>modern(s)?1:2;
const identity=(s,t)=>modern(s)?[t[0],...t.slice(1).sort((a,b)=>String(a).localeCompare(String(b)))].join(','):t.join(',');
module.exports={modern,factor,identity};
