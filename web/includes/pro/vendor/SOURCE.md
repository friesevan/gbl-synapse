PvPoke MIT-licensed sources, copied without modification from https://github.com/pvpoke/pvpoke at f627e89e53c0c7b903fff097df7a0ad0ac95decc.

Network/UI initialization and output are adapted in ../worker.js; the battle engine and rankers here are unchanged. Rankings and gamemaster data are pinned to the same commit.

The active multi-moveset ranking adapter uses the unchanged combat engine and GameMaster filtering, plus Pokemon.calculateConsistency. Rectangular category and overall scoring live in ../core.js and ../worker.js; the original square-population Ranker and RankerOverall files remain reference sources. See ../README.md for deliberate scoring differences.

Search metadata uses unchanged Pokemon initialization, move pools, generateTraits and needsXLCandy in ../worker.js. ../search.js implements the ranking search syntax against that metadata. The four ../data/meta-*.json league meta groups are copied from src/data/groups/{littlegeneral,great,ultra,master}.json at the same pinned commit.
