# Rolemaster skirmish adaptation

This fork starts directly in a standalone skirmish. The existing Ludus application
is unchanged. Upstream Zemeroth history, source and licenses are retained; the
old campaign and combat code are kept for upstream regression tests but are not
called by the Rolemaster runtime.

## Architecture and reproducibility

- `rolemaster-tactical` in the public `tharak/rolemasterCore` repository owns combat
  state, RNG, round declarations, initiative, table lookup, conditions and PP.
  Cargo pins an exact Git revision. No combat rules execute in JavaScript.
- `src/tactical.rs` owns scenarios, AI plans, UI commands and event projection.
  Enemy plans are generated from the round-start state before player declarations.
- Zemeroth's axial geometry, breadth-first pathfinder and original atlas are used
  for the battlefield. No old AP, armor, damage, hazard or free-reaction rules run.
- JSON saves contain the entire authoritative state, queue cursor, event log and
  RNG (as a decimal string to avoid JavaScript's integer rounding). Replay reads
  recorded frames without mutating the battle or rolling dice.
- Browser storage uses `zemeroth-rolemaster.skirmish.v1`, separate from Ludus.
  A tab that observes another tab's save freezes its controls. Save failures are
  shown in the interface. Reload pauses any in-progress resolution.
- Rust 1.99.0, Cargo.lock and resvg 0.23.0 are pinned. The loader is vendored from
  sapp-wasm 0.1.26, with its stale version label corrected and touch coordinates
  adjusted for an embedded canvas. Audio glue comes from macroquad 0.3.7.
- resvg 0.45.1 renders this old atlas's exported nodes transparent; use 0.23.0.
  No source PDFs are copied to the browser distribution.

## Playing

Choose a party member, an action, phase and activity percentage, and declare.
One action per fighter per phase and 100% total activity are enforced. Select an
empty hex to preview a movement destination. Full melee attacks need a fixed
foe; Press requires an adjacent foe at declaration. React pauses resolution for
a target choice within 50 feet. Select a friendly target for healing/blessings;
Blur always targets the caster. Commit the party to resolve the round.

Missing declarations mean waiting. Pause, step and speed controls are available
during resolution. Restart chooses one of three maps and a deterministic seed.
Replay displays recorded action snapshots, preserving the current battle.

Native keyboard controls currently cover selection (1–4), full attack (A), move
(M), commit (C), pause (Space) and step (N). The complete declaration interface
is currently browser-only.

## Explicit scenario profiles

All combatants are level five. These are designed skirmish statblocks, not claims
of verbatim printed character entries. They are fully specified in
`assets/tactical/{0,1,2}.json`. Strength and Quickness bonuses are zero and base
movement is 50 feet per round. Terrain is flat, one hex is five feet, and stone
walls block both movement and line of sight. Dead/unconscious units do not block
movement. The party has a Fighter (broadsword/shortbow), Cleric (mace), Magician
(dagger), and Mentalist (dagger). Enemy art is adapted from Zemeroth's imps.

## Current rules coverage and remaining audit

The current release is **experimental**, not completion of the full planned
Rolemaster implementation. Implemented: Snap/Normal/Deliberate ordering, 2d10
initiative, action budgets, normal movement, disengagement, full/press/react
attacks, OB allocation to parry, shortbow reload, weapon changes, open-ended d100,
weapon/bolt attack tables, equipment-selected critical results, bleeding,
cumulative stun, death timers, structural disability, spell preparation and PP,
and the seven curated spells. Mentalism attacks use A-10.9.11 before T-3.4 RRs.
Critical text/effects are generated from the audited shared JavaScript rules.

Remaining source-rule work is material:

- Fumble-table consequences are not yet applied; currently the attack is lost.
- Casting maneuver partial/near/unusual results and the spell-failure table need
  full handling; current casting maneuvers require a result above 60.
- Opportunity/cancellation rules, missile parry, shield assignment, and the full
  melee-vs-melee initiative modifiers are not yet implemented.
- React's no-target movement allowance is not yet available; waiting is supported.
- Critical recoil, unresolved conditional critical clauses, and all situational
  critical consequences are not fully automated. Review markers remain visible.
- Spell equipment/encumbrance restrictions and complete status/casting modifiers
  need their source audit. Current scenarios avoid prohibited caster armor.
- Native controls do not yet expose the full browser spell/declaration panel.

These limits must not be described as complete Rolemaster rules fidelity.

## Build and verification

```sh
cargo install resvg --version 0.23.0 --locked
sh utils/assets_export.sh
cargo test --workspace --locked
sh utils/wasm/build.sh
python3 -m http.server 8022 --directory static
```

The workspace suite retains 39 upstream game tests and adds scenario validation,
terrain pathfinding, AI isolation and completion of all three skirmishes. The
shared core separately tests table parity, activity budgets, phase ordering,
movement, invalid targets, healing restrictions, conditions, save determinism,
atomic errors and paused React choices.

`tests/browser-smoke.js` is a Playwright CLI `run-code --filename` test, including
five viewport sizes, declarations, duplicate commits, save/reload, replay, save
failure, stale tabs and complete battles. It expects the server above.
