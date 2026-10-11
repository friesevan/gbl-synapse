# Overnight team-strategy experiment

This is a runnable CPU-only starting point for improving PvPoke's existing Champion AI. It trains **five numerical strategy preferences**, using complete 3-on-3 battles. It does not train a neural network, learn new action sequences, prove optimal play, or update the website's AI automatically.

## Run

Install Node.js 20 or later from https://nodejs.org/ if necessary. No npm packages, Python environment or GPU are required. In a checkout of this repository:

```sh
node --test training/engine.test.cjs training/runner.test.cjs training/pool.test.cjs
node training/train.cjs --hours 8
```

On macOS, keep the computer awake while the command runs:

```sh
caffeinate -i node training/train.cjs --hours 8
```

Close neither the terminal nor the laptop lid. Independent battles run concurrently across a pool of workers. By default it uses all CPU cores reported by Node, capped by an estimated memory budget of 256 MB per worker using up to half of system RAM. On this 12-core, 64 GB M2 Max, that means 12 workers. Each worker is recycled every eight battles and has a 128 MB V8 old-generation limit; the main process retains checkpoints and aggregate results rather than simulation contexts. Eight hours is a wall-clock budget checked between battles; an in-progress battle may finish after the deadline. Training throughput depends on hardware and selected teams. Earlier strategy-tuning runs did not establish a dependable improvement over default Champion preferences; the neural team-search experiment focuses on team composition instead.

To resume for another eight hours:

```sh
node training/train.cjs --hours 8 --resume
```

To start an independent Ultra League experiment:

```sh
node training/train.cjs --cp 2500 --out training/runs/ultra --hours 8
```

Supported CP limits: 500, 1500, 2500, 10000. See `--help` for population, matchup and evaluation counts. The default output is `training/runs/overnight`. Changing league, seed or population/evaluation settings requires a new output directory; resume validates them.

For a quick end-to-end test:

```sh
node training/train.cjs --generations 1 --population 2 --games 1 --eval-games 1 --eval-every 1 --out training/runs/smoke
```

A startup message shows the deadline and checkpoint path. Progress messages appear approximately every ten seconds as battles complete, with cumulative battle count, active pool size, process RSS and the largest measured worker heap. Generation results still appear as JSON. Ctrl+C stops scheduling new jobs, waits for active battles, and saves progress. An incomplete generation is discarded. Interrupted candidate batches are discarded; the last completed generation remains the incumbent. Checkpoints use atomic replacement. Unexpected battle timeouts stop training instead of silently being rewarded as draws.

## What happens during training

1. Load the pinned league's top 60 recommended Pokémon and movesets. One quarter of species are held out entirely for evaluation; the others form training teams. Three distinct species are randomly selected per team; lead order varies.
2. Start with Champion's unmodified strategy preferences. Candidate results are accumulated in a fixed job order even when battles complete out of order, so worker count does not alter seeded results or tie-breaking. The five multipliers affect basic switching, farming before switching, shield baiting, farming, and shielding versus not shielding. Champion's underlying legal actions, timing, damage calculations, and replacement-selection rules remain in use.
3. Each generation includes the incumbent and five log-normal mutations, bounded to 0.1–10. Each candidate plays the **same eight team-pair fixtures**, twice with sides exchanged. This reduces team and side bias, although random decisions can still diverge between policies.
4. Opponents are the original Champion policy 75% of the time once the archive exists, otherwise 100%. The remaining opponents are sampled from up to twelve past incumbents. The mixture reduces narrow exploitation of one policy.
5. Choose the best candidate by mean game reward: win = 1, draw = 0.5, loss = 0. The incumbent wins exact ties. This is evolutionary parameter optimization; it is not policy-gradient reinforcement learning or a formal equilibrium solver.
6. Every fifth generation, evaluate against the original Champion on a fixed held-out fixture set, with both sides exchanged. Evaluation scores are **not used for promotion**. Save policy, checkpoint, and history after every completed generation.

The default validation set has only 32 battles per evaluation. Treat it as a diagnostic, not strong evidence of improvement. Repeatedly inspecting that set and adjusting the algorithm can indirectly overfit it. Before choosing a final policy, use a larger, newly seeded test set and compare against both Champion and archived policies.

## Files produced

- `checkpoint.json`: settings, generation, battle count, incumbent, archived opponents, evaluation history; consumed by `--resume`.
- `policy.json`: strategy multipliers and source/settings metadata. These can be applied through the same `chooseOption` adapter when a future team-battle UI is built.
- `history.jsonl`: one record per generation, including training reward and occasional held-out win/draw/loss counts.

A training reward of 0.65 is not a claim of a 65% general GBL win rate. It describes this particular sampled matchup batch and opponent mixture. An unchanged policy is a valid outcome: the initial rules may already be strong, or the search space and sample size may be insufficient.

## Engine adapter and important limitations

`engine.cjs` uses the repository's unchanged PvPoke combat engine and the matching TrainingAI/Player sources. An in-memory virtual scheduler advances the interactive training engine without waiting for real-time animations. It supplies full charged-move minigame completion, automates the player-side replacement prompt, and gives side 0 a matchup reevaluation after charged-move animations, corresponding to the engine's explicit side-1 reevaluation. It does not alter damage equations. Animation/switch-clock behavior still follows the upstream training engine.

The tests verify seeded reproducibility, complete team depletion, charged attacks, and execution with altered preferences. They are smoke tests, not a comprehensive proof of training-adapter parity. Catch timing, simultaneous knockouts/CMP, debuffs, switch-clock expiration and timed replacement behavior need dedicated comparison fixtures before using results as competitive evidence.

**Information boundary:** this experiment inherits TrainingAI's access to the opponent's actual energy and moves. It is a full-information research baseline, not an agent restricted to everything a human would know. It also inherits upstream switching heuristics; tuning their preferences cannot invent a sophisticated catch policy that they do not express.

## Development plan toward stronger strategy

### 1. Validate the environment

Create deterministic regression fixtures against PvPoke Training for damage, energy, CMP, charge timing, cooldown, forced replacements, buffs, and catches. Log decision/state traces and verify that a switch intended as a catch actually redirects the attack legally. Separate battle mechanics from UI/animation time. Do not optimize a flawed environment.

### 2. Establish baselines and measure this runner

Compare default Champion, tuned Champion, simple no-switch/always-throw policies, and archived policies across thousands of held-out team pairs. Exchange sides and lead orders. Report win/draw/loss rates with uncertainty estimated by resampling **team-pair fixtures**, rather than treating correlated mirrored battles as independent observations. Test multiple seeds and seasons. Measure improvement before adding expensive machine learning.

### 3. Add realistic observations and beliefs

Keep hidden teams and unrevealed moves outside the policy's input. Expose own team/HP/energy/shields, revealed enemy Pokémon, observed fast/charged attacks, switch clocks, and estimated opposing energy. Maintain distributions over unseen Pokémon and moves. Separate the engine's true state from the agent's observation. Use true state only for mechanics and, if justified, a training-only critic.

### 4. Introduce tactical search

Evaluate legal fast attacks, each charged attack, waits and switches over short horizons using opponent-policy rollouts. Resolve simultaneous choices without letting either player inspect the other's chosen action. Evaluate catches against a distribution over whether/when the opponent throws; compare incoming damage, retained energy, switch lock and subsequent alignment. Randomize actions when predictable behavior can be exploited. This may deliver useful improvements before neural training.

### 5. Train an unrestricted policy if the baseline plateaus

Build an explicit observation/action/reward environment. Start by imitating Champion's trajectories, then train recurrent self-play policies (for example PPO) against a league of historical opponents. Mask illegal actions. Use terminal team-battle wins as the principal reward; avoid rewarding every successful-looking catch independently, because a catch can lose the overall game. Track sample efficiency and exploitability proxies. This phase needs a new implementation and likely far more than one overnight CPU run.

### 6. Deploy only after independent testing

Export the policy and observation schema with a pinned mechanics/data version. Evaluate on unseen teams, different opponent styles and refreshed league data. Display estimated win rates and representative decision traces. Call it an improved strategy agent, not optimal play, unless a mathematically justified guarantee is available.

## Is overnight training necessary?

Not for adding full team battles or basic catching: PvPoke already supplies a usable team engine and switching AI. It is useful as an experiment to measure whether policy tuning improves outcomes. Truly optimal strategy is a harder simultaneous-action, imperfect-information problem, with randomized move effects and a large state space. Larger self-play training may help, but more compute alone does not establish optimality. Validate mechanics and improve tactical search first.

## References

- [PvPoke training AI design](https://pvpoke.com/articles/development/developing-trainer-battle-ai/)
- [Pinned PvPoke sources](https://github.com/pvpoke/pvpoke/tree/f627e89e53c0c7b903fff097df7a0ad0ac95decc)
- [ReBeL: reinforcement learning and search for imperfect-information games](https://arxiv.org/abs/2007.13544). Relevant research for a future agent; this runner does not implement ReBeL or inherit its theoretical guarantees.

## Recovering from the original out-of-memory crash

The original runner repeatedly compiled the combat engine into VM contexts within a long-lived Node process. Sustained runs accumulated enough memory to exhaust its heap. The updated runner isolates that work in a worker that is completely terminated every eight battles. It does not change battle mechanics or policy parameters, and it accepts existing checkpoints.

If you downloaded `PvPokeTrainerUpdate.zip`, open a terminal in your **existing** PvPokeTeamTrainer folder and run:

```sh
cp training/runs/overnight/checkpoint.json training/runs/overnight/checkpoint.before-update.json
unzip -o ~/Downloads/PvPokeTrainerUpdate.zip
caffeinate -i node training/train.cjs --hours 6 --resume
```

Adjust the ZIP path to where you downloaded it. The patch contains only training code and documentation; it does not contain or delete `training/runs`. Keep your original runs folder. If using Git, pull the updated branch instead, then use the same resume command.

`--hours 6 --resume` gives the resumed process a **new six-hour budget**, not just the hours remaining from the failed invocation. A fatal crash cannot run the shutdown handler, so an incomplete generation's simulations are lost; the last atomically saved completed generation remains available.

Optional sustained regression check:

```sh
node --max-old-space-size=128 training/soak.cjs 2048
```

This checks 2,048 full battles, periodically reports RSS and worker recycling, and fails on engine timeouts or excessive worker heap. Process RSS includes all threads and is greater than the worker's JavaScript heap limit. It is a bounded-memory regression test, not an overnight evaluation of strategic improvement.

Validation of the memory fix on Node 20.18.1: 2,048 full battles completed in 487 seconds, with peak sampled process RSS of 370 MB and peak sampled worker heap of 55 MB. Seeded battle/recycling tests, original first-generation result parity, checkpoint resume, Ctrl+C and automatic deadline exit also passed. This is a regression check beyond the observed failure point, not a claim that a six-hour run has been completed.

## M2 Max / multicore execution

The unchanged command now auto-selects 12 workers on a 12-core M2 Max:

```sh
caffeinate -i node training/train.cjs --hours 6 --resume
```

To specify the count explicitly:

```sh
caffeinate -i node training/train.cjs --hours 6 --resume --workers 12
```

For less CPU usage during other work, use `--workers 8` or a smaller number. Changing worker count does not invalidate checkpoints. Candidate and matchup seeds, score reduction order, and incumbent-first tie-breaking remain independent of execution order. New jobs stop at the time budget or on Ctrl+C; already-running battles finish before checkpointing and worker shutdown. The CPU pool does not use the GPU or Neural Engine: the existing simulator is branching JavaScript code, rather than a GPU tensor workload.

An existing process keeps the code it loaded at startup. To activate the multicore update, press Ctrl+C in that process's terminal, wait for the final Saved message, and restart with the resume command. Runtime updates do not migrate a live process or extend its deadline automatically.

Multicore validation on this M2 Max / Node 20.18.1: an identical 96-battle generation took 26.2 seconds with one worker and 7.2 seconds with 12 workers (about 3.6× faster), with identical scores and selected policy. A 384-battle parallel recycling check peaked at 1,209 MB sampled process RSS and 56 MB worker heap. Deadline exit, Ctrl+C and resuming an existing checkpoint with 12 workers passed. Short benchmark speedup may differ during sustained training.

## Neural search for team composition

A separate experiment now searches three-Pokémon teams from the top 300 Great League entries by default weight, using up to five scouted movesets each. It learns a neural predictor from complete team-battle outcomes, rather than modifying five strategy preferences. See [team-search/README.md](team-search/README.md). It stores its own checkpoints under `training/runs/team-search` and leaves the original strategy experiment intact.
