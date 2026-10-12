#!/usr/bin/env node
// Builds includes/meta/move-names.json: move names as the game shows them in other UI languages, so the
// "X used Y!" banners of Japanese, Korean, Chinese, German, French, Spanish and Italian videos can be read.
// Source: PokeAPI's CSV data (https://github.com/PokeAPI/pokeapi, data/v2/csv, BSD-3-Clause):
//   move_names.csv  (move_id, local_language_id, name)
// Usage: node build-move-names.cjs move_names.csv [OUT.json]
// PokeAPI moves are matched to PvPoke moves by their English name (a "(Fire)"-style suffix is dropped:
// Weather Ball, Techno Blast and Hidden Power show one name in the banner). Japanese uses the kana names
// (language 1), as the game does. Latin-script names equal to the English one are left out.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const C=require('../../includes/meta/core.js'),gm=require('../../includes/pro/data/gamemaster.json');
const LANGS={1:'ja',3:'ko',4:'zh-Hant',5:'fr',6:'de',7:'es',8:'it',9:'en',12:'zh-Hans'};
const [csv,outArg]=process.argv.slice(2);if(!csv){console.error('usage: node build-move-names.cjs move_names.csv [OUT.json]');process.exit(2);}
const out=outArg||path.join(__dirname,'../../includes/meta/move-names.json');
function rows(text){const out=[];for(const line of text.split(/\r?\n/)){if(!line)continue;const f=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(q){if(c==='"'&&line[i+1]==='"'){cur+='"';i++;}else if(c==='"')q=false;else cur+=c;}else if(c==='"')q=true;else if(c===','){f.push(cur);cur='';}else cur+=c;}f.push(cur);out.push(f);}return out;}
const byLang={};
for(const [id,lang,name] of rows(fs.readFileSync(csv,'utf8')).slice(1)){const l=LANGS[lang];if(!l||!name)continue;(byLang[l]||(byLang[l]={}))[id]=name.normalize('NFC');}
const pokeapiByEnglish=new Map(Object.entries(byLang.en).map(([id,name])=>[C.normalize(name),id]));
const base=name=>C.normalize(String(name).replace(/\s*\([^)]*\)\s*$/,''));
const names={},missing=[];
for(const m of gm.moves){const id=pokeapiByEnglish.get(base(m.name));if(!id){missing.push(m.name);continue;}
 for(const [l,map] of Object.entries(byLang)){if(l==='en'||!map[id])continue;const latin=!C.LOCALES[l]?.script;if(latin&&C.normalize(map[id])===base(m.name))continue;(names[l]||(names[l]={}))[m.moveId]=map[id];}}
const doc={source:'PokeAPI data/v2/csv/move_names.csv (https://github.com/PokeAPI/pokeapi, BSD-3-Clause)',built:new Date().toISOString().slice(0,10),
 note:'PvPoke moveId → move name in that UI language (matched by English name); Latin-script languages list only names that differ from English.',names};
fs.writeFileSync(out,JSON.stringify(doc)+'\n');
console.log(Object.entries(names).map(([l,m])=>`${l} ${Object.keys(m).length}`).join(', '),'→',out);
if(missing.length)console.log(`no PokeAPI name for ${missing.length} of ${gm.moves.length} PvPoke moves: ${missing.slice(0,30).join(', ')}`);
