# Meta Extractor — how it works, in plain language

The Meta Extractor watches a recording of Pokémon GO Battle League battles and writes down what happened: which Pokémon each side used, who led, who won, which attacks were thrown, and a few things the game never writes on screen, such as each Pokémon's fast move and whether it is a Shadow. It does all of this on your own computer. The video never leaves it.

This page is the short version. The [technical reference](README.md) has every rule, every number and every measurement.

## What it is for

Nobody publishes which teams people actually use in GO Battle League. Recordings do contain that information, one battle at a time. The extractor reads thousands of them so the site can show the *observed* meta by league, cup and week, and so [Team Rankings](../../training/team-search/README-plain.md) can search for teams against the opponents people really bring.

## What it looks at

The game draws the same things in the same places on every phone, so the extractor checks fixed spots on the screen rather than trying to understand the picture as a whole.

![The two nameplates: name, CP, three Poké Balls (red = still alive, dark = fainted), two shield icons and the type icons above](docs/frame-hud.jpg)

- **The two nameplates** at the top, on every sampled frame. The Poké Balls say how many Pokémon each side has lost and the shield icons how many shields are left. Because those numbers can only go up during a battle, a frame where everything is back to full is a new battle. The name and CP are read as text, once per Pokémon, and matched against the list of real Pokémon names, in ten game languages.

![HP bars and the regions below them where the extractor measures purple Shadow flames](docs/frame-bars.jpg)

- **The HP bars**, about ten times a second while a battle is on. Each fast attack takes a small step off the bar, and an orange trail shows exactly how much. The size and rhythm of those steps are compared with the game's damage formula for every fast move the Pokémon could have, which is how the fast move is worked out without it ever being named on screen. Shadow Pokémon hit harder and take more damage, so the same steps also hint at Shadow status.

![During a charged attack the camera frames one Pokémon on its own, which is the clearest view of its Shadow flames](docs/frame-focus.jpg)

- **The dark purple flames** of a Shadow Pokémon, in a box just below its HP bar, and especially in the moments when the camera frames one Pokémon on its own during a charged attack.

![The “X used Y!” banner that names a charged attack](docs/frame-banner.jpg)

- **The banners** in the middle of the screen: "Melmetal used Double Iron Bash!" names a charged attack, "Go, Cramorant!" marks a switch, and "SUPER EFFECTIVE!" above a bar tells which type of attack just landed.

![The YOU WIN screen, found by its large white letters before any text is read](docs/frame-result.jpg)

- **The result screen** (YOU WIN or GOOD EFFORT), the "Surrender and exit?" dialog, and the fade to black at the end of a battle. When an upload cuts the result screen, the Poké Balls and the last HP bars usually still say who lost.

If the phone screen is only part of the video, as in most YouTube uploads, the extractor first finds the phone's rectangle by looking for the place where the nameplates read correctly. Some edited uploads place the phone a few pixels differently in each clip, and a rectangle that far off reads nothing; the extractor then finds each placement from the Poké Balls and reads every clip with its own rectangle.

![A YouTube upload with the phone screen in the centre column, found automatically](docs/frame-screen-pokedeego.jpg)

## How it decides each thing

| Question | Answer comes from |
| --- | --- |
| Where does one battle end and the next begin? | Poké Balls and shields resetting, a result screen, or a fade to black |
| Which Pokémon? | the name on the nameplate, read as text and matched to the real list; a name that is only nearly right must also fit the CP and type icons shown next to it, and a plate half-hidden by a stream overlay is skipped |
| Who led? | the first opponent Pokémon seen |
| Who won? | the result screen if there is one; otherwise three fainted balls, or two plus an empty last bar, or the surrender dialog |
| Which charged attacks? | the "X used Y!" banners |
| Which fast move? | the size and timing of the HP-bar steps, the energy it must have earned to fire its charged attacks, the SUPER EFFECTIVE text, and what players usually run |
| Shadow or not? | the purple flames, the damage steps, and how often that species is Shadow in answered questions, combined by a small learned model |
| Which regional form? | the type icons above the nameplate, which charged moves it threw, and how well each form ranks |

Whenever any of these is uncertain, the extractor does not guess silently. It writes the battle down with the uncertainty attached and asks.

## When it asks you

The **Validate** tab shows a short queue of questions: "Is the opponent's Sableye a Shadow?", "Which fast move did Cradily use?", "Who won battle 3?". Each one plays the few seconds of video where the answer is visible and shows what the extractor measured ("5 hits of about 6% every 3 turns"). You answer with a click, or say "Not sure".

It only asks when it is genuinely unsure: a fast move below 85% confidence, a Shadow estimate between 15% and 85%, a form it could not settle, a result it could not read. Everything else is recorded without bothering you.

Some things it deliberately never asks. Forms that look exactly the same on screen (Gourgeist and Pumpkaboo in their four sizes) cannot be told apart by anyone watching, so the extractor settles them from how well each ranks and from the damage it measured. Pokémon that change form during the battle are one Pokémon, not several to choose from: Cramorant starts normal and turns Gulping or Gorging only after Dive or Surf, Mimikyu starts Disguised and turns Busted when a charged attack hits it, and Morpeko flips between Full Belly and Hangry with every Aura Wheel (which changes that move's type). The fast-move question lists the moves of every form still possible, so a move only one form learns is never missing; for example Thunder Shock, which only Hisuian Electrode has. Choosing a move that only one form learns also settles the form. Moves beyond the leading choices sit under an "Other move" list.

Championship broadcasts that show two phones side by side no longer get a "whose screen" question: the left phone is treated as the creator's battle, every time, so results are consistent. If you already answered that question, your answer still decides. It asks only when one phone is shown and the championship evidence is weak (it may be an ordinary battle video), or when two phones were found but could not be told apart.

## How it learns

Your answers do three things:

1. They correct that battle immediately.
2. After eight new answers, the models are refitted from the saved measurements (no video needed): how often each species runs each fast move, how often it is Shadow, and how much to trust each kind of evidence.
3. The refitted model is tested on videos it has never seen. Only if it is right at least 95% of the time on those does it earn the right to settle that kind of question on its own, and only above the confidence where that held true. Today it settles fast moves it is at least 90% sure of (102 of 103 held-out answers were right) and most "not a Shadow" calls; it still asks about regional forms. Anything it settles stays visible and can be reversed, and a person's answer always wins.

The **Model performance** view in Validate shows these numbers after every refit.

## How accurate is it

On nine labelled recordings (three from a phone, six from YouTube), it found every battle without inventing any, read every opponent's name correctly (233 of 233), and got every result right except one battle where the recorder left the app. On questions where the answer is not written on screen, tested on recordings the model was not fitted on: fast moves are right 166 of 197 times, regional forms 25 of 31, and Shadow status 323 of 410. Those are also exactly the cases it asks about when unsure, so the recorded data is better than those raw numbers once answers come in.

## How fast is it

On a 12-core laptop, the batch engine used by the YouTube harvester analyses about 34 minutes of video per minute with eight workers (one worker alone runs at 5–7× real time). Most of that time is spent decoding the video, not analysing it. Re-checking old recordings with an improved model takes seconds, because every measurement is saved and no video is needed. Analysing a recording in the browser is slower, because a browser can only jump through a video rather than stream it, but it needs nothing installed.

## What it cannot do yet

- Tell apart two fast moves that do the same damage on the same rhythm (for example Thunder Shock and Bite on Morpeko) when the effectiveness text does not help.
- See the Shadow flames of a Pokémon the camera never frames alone, or of species whose body is purple anyway.
- Read a result the upload cut away when the Poké Balls do not settle it.
- Tell apart two forms with identical types and moves, such as Dialga and Dialga Origin, except by what players usually run.
- Read nicknames on the recorder's own side (it now skips them instead of guessing a species, for example a Japanese nickname that looked like Blitzle).
- Name a Pokémon whose nameplate a stream overlay hides on every frame; it gives no name rather than a wrong one.
- Name the Pokémon in uploads whose crop cuts the names off the top of the phone screen.

The [technical reference](README.md#10-gaps-and-improvement-areas) lists what would fix each of these, and what would make it faster.

## Privacy

Analysis runs on the device that holds the recording. What can be saved or shared is a summary: species, results, moves, dates and HP percentages. No frames, no video and no trainer names are stored. Footage that is not Creative Commons is never sent to any online service.

## Credits

The figures are frames from Creative Commons Attribution videos by KZ FAM and PokeDeeGO. Pokémon data comes from PvPoke; text is read with Tesseract.
