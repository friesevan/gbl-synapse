# Observation-limited controller v4

## Information available to each side

The simulator necessarily contains both true rosters to resolve combat. The **decision policy** receives its own roster/resources and observations of the opponent; its opponent forecasts are newly constructed Pokémon based on public metadata and a meta prior.

Allowed inputs:

- Its own Pokémon, moves, HP, energy, IVs, buffs and cooldowns.
- Species/forms that have actually appeared, visible HP bar rounded to 1% (living Pokémon retain at least 1%), and publicly displayed buff stages.
- Public shield counts and switch clocks, representing precisely tracked visible uses/switches. Exact opponent fast cooldown is estimated from the observed move duration and turn count, rather than read from the opponent object.
- Resolved fast-move identities/counts and charged-move identities. A move is recorded **after** resolution, including shielded charged attacks. Automatic uneditable form attacks such as Gulp Missile are not mistaken for a selected moveset slot.
- A separately generated public meta prior, not the actual opponent fixture or its seed.

Withheld inputs:

- Unrevealed backline Pokémon, their live resources or moves.
- The opponent's true selected moves, exact energy, IVs, attack/defense or HP maximum.
- Queued actions or the charged move currently awaiting a shield decision.

The HP observation adapter reads live HP/maxHP only to produce the visible percentage; it does not pass those exact values to the policy. Metadata/default-IV stats are predictions. Public forms/buffs and shield/switch clocks are treated as perfectly observed; realistic counting mistakes, visual delays and lag are not modeled yet.

## Updating beliefs

Each side independently records first revealed species as the lead and tracks later reveals. Fast moves add publicly known energy gains to an estimate, capped at 100; resolved charged moves subtract their now-known cost. Energy survives observed switches; temporary stages clear on withdrawal. This is a perfect-counting estimate, not access to the internal energy field. It does not infer missed fast attacks or probabilistic energy intervals.

Unknown moves start from the meta's published recommended moveset. Observed fast/charged moves override those predictions. After one unusual charged move is revealed, it is retained and the remaining unobserved slot stays a recommendation. This is a simple moveset completion rule, **not** a learned probability distribution over all legal movesets. Unknown IVs use default initialization.

For backlines, the trainer generates an independent 2,048-lineup bank from the configured meta, once per run. A controller filters this bank to the observed lead and all revealed species. It samples three possible lineups by default, retaining observed HP/energy/buffs for revealed members and fresh starting resources for hidden members. The bank is a finite approximation: for a rare lead/core it may have no match. Then remaining slots are sampled from the configured weight-powered marginal roster, without duplicate Pokédex numbers. This fallback loses joint correlations; it is labeled an approximation rather than an exact Bayesian posterior. Matching bank entries are cached until a new species is revealed. The meta distribution itself is unchanged.

`--belief-samples N` configures 1–16 forecast worlds (default 3). More worlds reduce sampling noise but cost more simulation work. `beliefRoster`, `beliefTeams`, and sample count are saved in each report for exact replay; they contain only public prior data, not privileged per-battle truth.

## Decisions

Switching evaluates legal own choices against legal opposing responses in each imagined lineup. It takes a conservative response value per lineup, then averages across those lineups. Bounded active-pair rollouts include predicted HP, energy, shields, forms and switch locks, with surviving-roster coverage/resource value at the horizon. A voluntary switch still requires the existing improvement margin. Forecasts always put the decision-maker in the same canonical physical slot, avoiding side-dependent policy ties. Policy randomness depends only on own state, public observations and the battle seed; hidden roster identities never enter its key.

Champion's original attack/shield methods also read hidden opponent moves and energy. They are replaced in v4: attack choice evaluates affordable own attacks against the predicted visible opponent, favors cheaper attacks when shields remain, avoids unnecessary charged overkill when a fast move can finish, and favors energy-efficient/lethal attacks otherwise. Shield choice considers predicted affordable opposing attacks and their expected damage; it never reads the real incoming move argument. These are deliberately simple observation-limited heuristics, not a newly trained optimal strategy.

Hypothetical rollouts use predicted moves and default simulator charge/shield behavior. They are forecasts, not claims about the opponent's true next action. Delayed catches, mixed strategies, full-roster continuation rollouts (beyond the one-replacement continuation option below), an information-limited learned terminal value, and probabilistic shield/bait prediction remain future work.

## Controller options

The decisions above are the default v4 controller, and every published v4 label uses them. Since 2026-10-13 the controller also takes options (defined once, in `lookahead-v4.js` between the `<controller-options>` markers; Node reads the same source through `controller-options.cjs`, and the browser replay through its generated adapter). Absent options are the defaults, and the defaults are pinned byte for byte by `mechanics-fixtures.test.cjs` and `forecast-reuse.test.cjs`.

| Option | Default | What it changes | Search flag |
| --- | --- | --- | --- |
| `replyModel` | `worst` | `weighted`: each lineup's value of an own choice is the expectation over the opponent's legal replies with probability proportional to exp(u / T), where u is the reply's value for the opponent (the rollout value negated) under the same imagined lineup; `worst` takes the minimum | `--reply-model` |
| `replyTemperature` | 0.25 | T for weighted replies (0 < T ≤ 10); T → 0 is the worst case, large T the plain mean | `--reply-temperature` |
| `rolloutContinuation` | 0 | N > 0 (at most 24): a forecast duel that ends with a knocked-out Pokémon continues with the forced replacement for up to N more steps | `--rollout-continuation` |
| `switchMargin` | 0.08 | the improvement a voluntary switch needs; 0 switches on any forecast gain; 1e9 or more never switches voluntarily (forced replacements still happen) | none (policy panel only) |
| `shieldPolicy` | `default` | `always`: shield every charged attack while shields remain; `never`: never shield | none (policy panel only) |

Options apply to both sides, or to one side through `controllerTeams: [optionsA, optionsB]` (in caller order; they follow their teams into physical slots as `plannerTeams` does).

*Weighted replies.* The worst case assumes an opponent who always finds the reply that is worst for us, inside a forecast that already guesses its moves, energy and backline. Real opponents choose with the same uncertainty, so a softmax over their own values is a less paranoid model of a competent player. The rollouts, and therefore the branch cache, are identical under both models: a cached branch value is the same and only the aggregation differs. The expectation is computed exactly, not sampled, so no random stream is consumed and decisions are deterministic. At the default temperature it rarely changes a decision (3 of 24 search-shaped battles changed in a sweep; 7 of 24 at T = 1).

*Rollout continuation.* Without it, a forecast in which our active Pokémon faints at turn 10 is valued by the terminal heuristic on a knocked-out pair, although the battle would continue with a replacement. With N > 0, when the duel ends with a faint (including a faint on the last horizon step) and that side still has a living bench, each legal replacement is tried: the duel continues for up to N steps from the survivor's post-duel state against the replacement (entering with no cooldown and the remaining shields), and the replacing side keeps the replacement whose continued value is best for it; when both sides lose their Pokémon at once, the decider takes the maximin over both replacements. The continuation is one replacement deep. Its cost is bounded by 2 × 2 continuation duels of at most N steps per continued branch, and planner statistics report it (`rolloutSteps`, `continuations`, `continuationDuels`, `continuationSteps`, only when a side uses the option, so default statistics keep their exact shape). Continued duels are shared across belief worlds for the step, like first duels. The branch key carries N, so a side with continuation and a side without never share a branch value.

*Switch margin and shield policy* exist so that the policy-diversity panel (`policy-panel.cjs`, search `--policy-panel N`) can drive the opponent side in styles a human might play: never switching, switching eagerly, always or never shielding. They are deliberately crude extremes. A side that never switches skips its voluntary decision entirely; this changes planner statistics but not play.

*Information boundary.* None of the options reads anything new: the continuation and the weighted aggregation use only the forecast rows (own roster, observed and imagined opponents) that the default already uses, and the shield policies use the public shield count. `observations.test.cjs` repeats the hidden-bench, unrevealed-move and true-energy counterfactual under every option, battle-wide and for the deciding side only, on both physical sides.

*Identity.* A non-default controller is a different controller. A search run with options records them in `config.controller`, and its mechanics id becomes the v4 id plus a readable suffix (`…+controller:replyModel=weighted,replyTemperature=0.25`). Resume, warm start, merge and export compare that id, so such a run never mixes labels with default runs; its portable report carries the options in `engineOptions`, and the browser adapter replays it only when the suffix matches those options (a default report claiming the suffix, or a variant report under the default id, is refused). Per-side controllers have no single identity and are refused in reports; they are for evaluation (the policy panel, `controller-ab.cjs`). When the two sides run different controllers, distinct teams keep the default orientation (so a style replays the default battle's seed and physical slots) and identical teams are no longer a mirrored pair.

*Limits.* The temperature 0.25 is a guess, not fitted to human choices. Weighted replies keep the same three imagined lineups, so they model uncertainty about the reply, not about the backline. The continuation picks a replacement by simulating each candidate, which is the controller's own forecast, not a model of how players choose; it is one replacement deep and does not continue after a second faint. Neither option is shown to be stronger or more human: the measured head-to-head results are in [the controller findings](../team-search/findings/controller.md).

## Verification and compatibility

- Counterfactual tests change hidden bench species, unrevealed charged moves and true energy while preserving visible state. The tested attack and shield decisions and observation records remain identical, for the default controller and under every controller option.
- `controller-options.test.cjs` requires every option to be deterministic, to reproduce exactly on the unoptimised forecast path (so the forecast-reuse caches stay correct), to be side invariant, and explicit defaults to equal the default controller byte for byte.
- Poisoned real-opponent/incoming-move arguments throw on any property access; tested policy methods ignore them.
- Tests verify side invariance, observed move/energy updates, conditioning on revealed lead/core, live-state preservation, repeated browser-worker requests and exact trainer/browser outcome parity.
- A full 12-core smoke run completes training, screening, final testing and portable report export. Small smoke scores are correctness evidence only.

Changing the controller changes the labels. v1–v3 battle outcomes and neural weights cannot warm-start v4. Their candidate identities can be starting ideas, but require new simulation. Unchanged scouting/pool data can be reused. New output is `training/runs/team-search-v4`; old directories remain intact. No new overnight accuracy result is claimed yet.
