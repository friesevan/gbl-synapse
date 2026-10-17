#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),pool=path.join(root,'training/runs/team-search/pool.json');
if(!fs.existsSync(pool))throw Error('Prepare the pool first: node training/team-search/prepare.cjs --species 300 --movesets 5 --shortlist 10000 --scout-opponents 300 --out training/runs/team-search/pool.json');
const previous=path.join(root,'training/runs/team-search-v3-refined-20261010/checkpoint.json'),hints=fs.existsSync(previous)?['--seed-teams',previous]:[];
// Previous champions: the published v1 and v3 primaries and the primary of every completed run (final panel of at least
// 256 fixtures) with this pool's hash, deduplicated by composition. They join the final panel as the fixed
// `previous-champions` baseline group. --champions FILE[,FILE...] replaces the automatic list; --champions none disables it.
const given=process.argv.slice(2),explicit=given.includes('--champions'),next=[];
if(!explicit){const {defaultChampionSources}=require('./champions.cjs'),prepared=JSON.parse(fs.readFileSync(pool,'utf8')),outIndex=given.indexOf('--out'),sources=defaultChampionSources(root,prepared,{exclude:[path.resolve(root,outIndex>=0?given[outIndex+1]:'training/runs/team-search-v4')]});if(sources.length){next.push('--champions',sources.join(','));console.log('Previous champions (fixed baseline group on the final panel): '+sources.map(s=>path.relative(root,s)).join(', '));}}
const result=spawnSync(process.execPath,[path.join(__dirname,'launch.cjs'),'--hours','8','--pool',pool,'--out','training/runs/team-search-v4','--meta','hybrid',...hints,...next,...given],{cwd:root,stdio:'inherit'});process.exitCode=result.status??1;
