# Rolemaster skirmish adaptation

This browser game uses individual initiative turns. The separate Ludus/fieldbook
application and the core's full-round declaration API are unchanged.

## Playing

Each round rolls initiative once and interleaves allies and enemies. The gold
ring and initiative list identify the active fighter. Any fighter can be
inspected or targeted; only your active fighter accepts commands.

Move optionally before acting, up to 25 feet for the current 50-foot profiles.
Tap/click an empty hex (or use Destination), inspect the blue route, then press
**Move here**. The coordinate menu supplies a keyboard alternative. Movement can
be split across confirmations but cannot resume after the main action.

Choose **Attack** or **Cast**, choose a target, then confirm. Attack uses the
equipped melee/missile weapon. Friendly spells target allies; Blur targets the
caster. Casting is always unprepared and uses the existing unprepared penalties.
All actions use Normal timing; movement does not reduce attack OB.

**Parry** creates a reserve equal to the usable melee weapon's nonnegative full
OB against all melee opponents. Each incoming melee attack spends the smallest
amount that removes both hits and criticals, or the remaining reserve if it cannot
prevent the hit. Misses and fumbles spend nothing. Missiles and spells bypass it.
The reserve and each expenditure are displayed. It expires at the start of the
fighter's next turn, even if that turn is skipped. Existing parry restrictions
still apply.

Attack, Parry, Cast (including Blur), Reload, Recover weapon, Change weapon and
Stand up each consume the main action. Reload advances up to 100 existing units;
recovery advances one recovery round. **End turn** waits without attacking.
Playback finishes before the next fighter acts. Pause, Step and Speed are
available; Resume continues enemy turns after reloading a paused save. Reduced
motion suppresses interpolation. Native shortcuts: 1–4 inspect, A attack,
M confirm movement, C end turn, Space pause, N step.

## Architecture and saves

- `rolemaster-tactical` in `tharak/rolemasterCore` owns initiative, command
  validation, movement budget, action availability, reserves, dice, combat tables,
  conditions, costs and cleanup. Cargo pins an exact Git revision.
- `src/tactical.rs` owns scenarios, enemy choices, selection, playback and the
  browser bridge. Enemy choices use the battlefield at the start of their turn
  (and again after movement); no round-wide enemy plan is queued.
- Commands include the expected actor and monotonic sequence. Core rejection of
  duplicate/out-of-turn commands is atomic, including RNG and resources.
- Saves version 2 use `zemeroth-rolemaster.skirmish.v2`, including complete core
  state, movement spent, initiative position, RNG as a decimal string, reserves,
  and recorded playback. Reload pauses playback without rerolling or reapplying.
- Version 1 remains untouched under `zemeroth-rolemaster.skirmish.v1`. Its queued
  declarations are never interpreted as turns. A notice explains that those
  battles must restart under the new rules.
- Replay reads recorded fighters without changing live combat. Commands that
  would advance combat are rejected during replay. Save failures are shown;
  another tab's save freezes local commands until reload.
- Round cleanup (including bleeding, condition expiration and death timers) runs
  once after the last initiative entry. Victory is finalized after cleanup.

## Profiles and limitations

Three scenarios live in `assets/tactical/{0,1,2}.json`. These are designed level
five statblocks, not verbatim printed characters. Base movement is 50 feet,
Quickness/Strength bonuses are zero, and hexes are five feet. Walls block movement
and sight. Dead/unconscious fighters do not occupy movement hexes. The original
Zemeroth artwork, geometry and pathfinder remain; its old AP/combat rules do not
run in this mode.

Preserved combat includes equipped weapon tables, ranges, reload, open-ended
d100, equipment-selected criticals, seven curated spells, PP, Mentalism basic
attacks and resistance tables, bleeding, cumulative stun, death timers,
structural disability, and one-handed/missile fumble consequences.

This remains experimental. Casting partial/near/unusual results and complete
spell-failure handling, opportunity attacks, shield assignment, full situational
initiative modifiers, critical recoil, unresolved conditional critical clauses,
and complete equipment/encumbrance restrictions remain outside current coverage.
The simplified turn rules deliberately omit Prepare, Press, React and Disengage.
Do not describe this mode as complete printed Rolemaster fidelity.

## Build and verification

Rust 1.99.0, Cargo.lock and resvg 0.23.0 are pinned. The browser loader is vendored
from sapp-wasm 0.1.26; audio glue comes from macroquad 0.3.7.

```sh
cargo install resvg --version 0.23.0 --locked
sh utils/assets_export.sh
cargo test --workspace --locked
sh utils/wasm/build.sh
python3 -m http.server 8022 --directory static
```

`tests/browser-smoke.js` runs via Playwright CLI `run-code --filename`. It checks
five viewport sizes, absence of declaration controls, touch movement and target
selection, duplicate movement/actions, exact mid-turn reload, reserves, replay,
failed saves, legacy preservation, stale tabs and completion of all three maps.
Create `output/playwright/` for its ignored screenshots.

The Rust game suite includes deterministic save/reload comparison at every step
of all three simplified battles, plus retained upstream and full-round tests.
Core tests cover initiative ties, movement plus action, unprepared casting,
utility progress, skipped turns, cleanup exactly once, invalid-command atomicity,
and reserve behavior for repeated attackers, misses, fumbles, critical-only
results, insufficient reserves, prohibited parrying, missiles/spells and expiry.
