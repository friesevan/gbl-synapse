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

Hypothetical rollouts use predicted moves and default simulator charge/shield behavior. They are forecasts, not claims about the opponent's true next action. Delayed catches, mixed strategies, full-roster continuation rollouts, an information-limited learned terminal value, and probabilistic shield/bait prediction remain future work.

## Verification and compatibility

- Counterfactual tests change hidden bench species, unrevealed charged moves and true energy while preserving visible state. The tested attack and shield decisions and observation records remain identical.
- Poisoned real-opponent/incoming-move arguments throw on any property access; tested policy methods ignore them.
- Tests verify side invariance, observed move/energy updates, conditioning on revealed lead/core, live-state preservation, repeated browser-worker requests and exact trainer/browser outcome parity.
- A full 12-core smoke run completes training, screening, final testing and portable report export. Small smoke scores are correctness evidence only.

Changing the controller changes the labels. v1–v3 battle outcomes and neural weights cannot warm-start v4. Their candidate identities can be starting ideas, but require new simulation. Unchanged scouting/pool data can be reused. New output is `training/runs/team-search-v4`; old directories remain intact. No new overnight accuracy result is claimed yet.
