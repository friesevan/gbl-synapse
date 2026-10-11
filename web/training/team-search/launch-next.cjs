#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),pool=path.join(root,'training/runs/team-search/pool.json');
if(!fs.existsSync(pool))throw Error('Prepare the pool first: node training/team-search/prepare.cjs --species 300 --movesets 5 --shortlist 10000 --scout-opponents 300 --out training/runs/team-search/pool.json');
const previous=path.join(root,'training/runs/team-search-v3-refined-20261010/checkpoint.json'),hints=fs.existsSync(previous)?['--seed-teams',previous]:[];
const result=spawnSync(process.execPath,[path.join(__dirname,'launch.cjs'),'--hours','8','--pool',pool,'--out','training/runs/team-search-v4','--meta','hybrid',...hints,...process.argv.slice(2)],{cwd:root,stdio:'inherit'});process.exitCode=result.status??1;
