#!/usr/bin/env node
// Builds includes/meta/species-names.json: species names as the game shows them in other UI languages,
// so nameplates of Japanese, Korean, Chinese, German, French, Spanish and Italian videos can be matched.
// Source: PokeAPI's CSV data (https://github.com/PokeAPI/pokeapi, data/v2/csv, BSD-3-Clause):
//   pokemon_species_names.csv  (pokemon_species_id, local_language_id, name, genus)
// Usage: node build-species-names.cjs pokemon_species_names.csv [OUT.json]
// Only names that differ from the English one (after core.js normalisation) are kept for Latin-script
// languages; every name is kept for Japanese, Korean and Chinese.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const C=require('../../includes/meta/core.js');
const LANGS={1:'ja',3:'ko',4:'zh-Hant',5:'fr',6:'de',7:'es',8:'it',9:'en',12:'zh-Hans'};
const [csv,outArg]=process.argv.slice(2);if(!csv){console.error('usage: node build-species-names.cjs pokemon_species_names.csv [OUT.json]');process.exit(2);}
const out=outArg||path.join(__dirname,'../../includes/meta/species-names.json');
// Minimal CSV reader (quoted fields may hold commas).
function rows(text){const out=[];for(const line of text.split(/\r?\n/)){if(!line)continue;const f=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(q){if(c==='"'&&line[i+1]==='"'){cur+='"';i++;}else if(c==='"')q=false;else cur+=c;}else if(c==='"')q=true;else if(c===','){f.push(cur);cur='';}else cur+=c;}f.push(cur);out.push(f);}return out;}
const table=rows(fs.readFileSync(csv,'utf8')).slice(1),byLang={};
for(const [dex,lang,name] of table){const l=LANGS[lang];if(!l||!name)continue;(byLang[l]||(byLang[l]={}))[dex]=name.normalize('NFC');}
const en=byLang.en,names={};
for(const [l,map] of Object.entries(byLang)){if(l==='en')continue;const latin=!C.LOCALES[l]?.script;names[l]={};
 for(const [dex,name] of Object.entries(map)){if(latin&&en[dex]&&C.normalize(en[dex])===C.normalize(name))continue;names[l][dex]=name;}}
const doc={source:'PokeAPI data/v2/csv/pokemon_species_names.csv (https://github.com/PokeAPI/pokeapi, BSD-3-Clause)',built:new Date().toISOString().slice(0,10),
 note:'National Pokédex number → species name in that UI language; Latin-script languages list only names that differ from English.',names};
fs.writeFileSync(out,JSON.stringify(doc)+'\n');
console.log(Object.entries(names).map(([l,m])=>`${l} ${Object.keys(m).length}`).join(', '),'→',out);
