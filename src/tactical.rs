//! Rolemaster host adapter. Combat mutations exclusively belong to rolemaster-tactical.
use crate::{
    assets,
    core::{
        battle::{component::ObjType, movement::Pathfinder},
        map::{Distance, PosHex},
    },
    geom,
};
use mq::prelude::*;
use rolemaster_tactical::{data::DataPack, *};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::BTreeSet};

#[derive(Clone, Serialize, Deserialize)]
struct Scenario {
    id: usize,
    name: String,
    description: String,
    radius: i32,
    walls: BTreeSet<Hex>,
    fighters: Vec<Fighter>,
}
fn scenarios() -> Vec<Scenario> {
    [
        include_str!("../assets/tactical/0.json"),
        include_str!("../assets/tactical/1.json"),
        include_str!("../assets/tactical/2.json"),
    ]
    .iter()
    .map(|s| serde_json::from_str(s).unwrap())
    .collect()
}
#[derive(Clone, Serialize, Deserialize)]
struct Frame {
    fighters: Vec<Fighter>,
    event: Option<CombatEvent>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Save {
    version: u32,
    scenario: usize,
    seed: u64,
    battle: BattleState,
    draft: RoundPlan,
    ai: RoundPlan,
    selected: u32,
    target: Option<u32>,
    destination: Option<Hex>,
    history: Vec<Frame>,
}
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Command {
    Invalid {
        message: String,
    },
    ReactChoice {
        target: Option<u32>,
    },
    Select {
        id: u32,
    },
    Target {
        id: u32,
    },
    Destination {
        q: i32,
        r: i32,
    },
    Declare {
        phase: Phase,
        activity: u8,
        kind: String,
        spell: Option<Spell>,
        parry: i32,
    },
    Clear,
    Commit,
    Step,
    Pause,
    Freeze,
    Motion {
        reduced: bool,
    },
    Speed {
        seconds: f32,
    },
    Restart {
        scenario: usize,
        seed: u64,
    },
    Restore {
        save: Save,
    },
    Replay {
        index: Option<usize>,
    },
}
thread_local! {
    static INPUT:RefCell<Vec<Command>>=const{RefCell::new(Vec::new())};
    static SNAPSHOT:RefCell<Vec<u8>>=const{RefCell::new(Vec::new())};
}
// This bridge carries UI commands/snapshots only. All rules execute in Rust.
#[no_mangle]
pub extern "C" fn rm_alloc(len: usize) -> *mut u8 {
    if len > 16_000_000 {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}
#[no_mangle]
pub unsafe extern "C" fn rm_command(ptr: *mut u8, len: usize) {
    let bytes = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
    let command = parse_command(&bytes).unwrap_or_else(|e| Command::Invalid {
        message: format!("Cannot read command or saved battle: {e}"),
    });
    INPUT.with(|q| q.borrow_mut().push(command));
}
// Deserialize nested saves with serde_json's numeric map-key support. An internally
// tagged enum buffers content and otherwise loses that support for u32-keyed maps.
fn parse_command(bytes: &[u8]) -> Result<Command, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    if value["type"] == "Restore" {
        return serde_json::from_value(value["save"].clone()).map(|save| Command::Restore { save });
    }
    serde_json::from_slice(bytes)
}
#[no_mangle]
pub extern "C" fn rm_snapshot_ptr() -> *const u8 {
    SNAPSHOT.with(|s| s.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn rm_snapshot_len() -> usize {
    SNAPSHOT.with(|s| s.borrow().len())
}

fn pos(p: Hex) -> PosHex {
    PosHex { q: p.q, r: p.r }
}
fn hex(p: PosHex) -> Hex {
    Hex { q: p.q, r: p.r }
}
fn path(b: &BattleState, id: u32, to: Hex, from: Hex) -> Vec<Hex> {
    if !b.inboard(to) {
        return vec![];
    }
    let mut finder = Pathfinder::new(Distance(b.radius));
    finder.fill_terrain(pos(from), |p| b.open(hex(p), id));
    finder.path(pos(to)).map_or(vec![], |p| {
        p.tiles().iter().skip(1).map(|p| hex(*p)).collect()
    })
}
fn ai_plan(b: &BattleState) -> RoundPlan {
    ai_plan_for_team(b, 1)
}
fn ai_plan_for_team(b: &BattleState, team: u8) -> RoundPlan {
    let mut plan = RoundPlan::default();
    for f in b
        .fighters
        .iter()
        .filter(|f| f.team == team && f.can_act(b.round))
    {
        let t = match b
            .fighters
            .iter()
            .filter(|t| t.team != f.team && t.conscious())
            .min_by_key(|t| (t.pos.distance(f.pos), t.id))
        {
            Some(t) => t,
            None => continue,
        };
        let w = &f.weapons[f.weapon];
        let (activity, action) = if f.has("mustParry", b.round) {
            (0, Action::Wait)
        } else if f.spells.contains(&Spell::ShockBoltI)
            && f.pp >= 2
            && b.line_of_sight(f.pos, t.pos)
        {
            if f.preparation
                .as_ref()
                .is_some_and(|p| p.spell == Spell::ShockBoltI && p.rounds >= 1)
            {
                (
                    75,
                    Action::Cast {
                        spell: Spell::ShockBoltI,
                        target: t.id,
                    },
                )
            } else {
                (
                    90,
                    Action::Prepare {
                        spell: Spell::ShockBoltI,
                    },
                )
            }
        } else if w.reload > 0 && f.pos.distance(t.pos) <= 1 {
            (
                50,
                Action::ChangeWeapon {
                    index: 1.min(f.weapons.len() - 1),
                },
            )
        } else if w.reload > 0 && f.reload_left > 0 {
            (f.reload_left.min(100) as u8, Action::Reload)
        } else if f.pos.distance(t.pos) * 5 <= w.range && b.line_of_sight(f.pos, t.pos) {
            if w.reload > 0 {
                (60, Action::Missile { target: t.id })
            } else {
                (100, Action::Melee { target: t.id })
            }
        } else {
            let route = t
                .pos
                .neighbors()
                .iter()
                .filter(|p| b.open(**p, f.id))
                .map(|p| path(b, f.id, *p, f.pos))
                .filter(|p| !p.is_empty())
                .min_by_key(|p| p.len())
                .unwrap_or_default();
            if route.is_empty() {
                (0, Action::Wait)
            } else {
                (
                    80,
                    Action::Move {
                        path: route.into_iter().take(8).collect(),
                    },
                )
            }
        };
        let phase = if matches!(action, Action::Move { .. }) {
            Phase::Deliberate
        } else {
            Phase::Normal
        };
        let declaration = ActionDeclaration {
            actor: f.id,
            phase,
            activity,
            action,
        };
        let mut candidate = plan.clone();
        candidate.actions.push(declaration);
        if b.validate_plan(&candidate, Some(team)).is_ok() {
            plan = candidate;
        }
    }
    plan
}
struct Game {
    save: Save,
    data: DataPack,
    error: String,
    paused: bool,
    seconds: f32,
    last: f64,
    revision: u64,
    replay: Option<usize>,
    reduced_motion: bool,
}
impl Game {
    fn new(scenario: usize, seed: u64) -> Result<Self, String> {
        let s = scenarios()
            .get(scenario)
            .cloned()
            .ok_or("Unknown scenario")?;
        let battle = BattleState::new(s.fighters, s.radius, s.walls, seed)?;
        let ai = ai_plan(&battle);
        let history = vec![Frame {
            fighters: battle.fighters.clone(),
            event: None,
        }];
        Ok(Self {
            save: Save {
                version: 1,
                scenario,
                seed,
                battle,
                draft: RoundPlan::default(),
                ai,
                selected: 1,
                target: Some(11),
                destination: None,
                history,
            },
            data: DataPack::bundled(),
            error: String::new(),
            paused: true,
            seconds: 0.8,
            last: 0.,
            revision: 1,
            replay: None,
            reduced_motion: false,
        })
    }
    fn publish(&self) {
        let snapshot = serde_json::json!({"revision":self.revision,"save":self.save,"error":self.error,"paused":self.paused,"replay":self.replay,"scenarios":scenarios().iter().map(|s|serde_json::json!({"name":s.name,"description":s.description})).collect::<Vec<_>>()});
        SNAPSHOT.with(|s| *s.borrow_mut() = serde_json::to_vec(&snapshot).unwrap());
    }
    fn step(&mut self) -> Result<(), String> {
        let events = self.save.battle.step(&self.data)?;
        if !events.is_empty() {
            self.save.history.push(Frame {
                fighters: self.save.battle.fighters.clone(),
                event: events.last().cloned(),
            });
        }
        if let Some(id) = self.save.battle.awaiting_react {
            self.save.selected = id;
            self.paused = true;
        }
        if !self.save.battle.resolving {
            self.paused = true;
            self.save.draft = RoundPlan::default();
            self.save.ai = ai_plan(&self.save.battle);
        }
        self.last = get_time();
        Ok(())
    }
    fn command(&mut self, c: Command) -> Result<(), String> {
        match c {
            Command::Invalid { message } => return Err(message),
            Command::ReactChoice { target } => {
                self.save.battle.choose_react(target)?;
                self.paused = false;
                self.last = get_time();
            }
            Command::Select { id } => {
                let f = self.save.battle.fighter(id).ok_or("Unknown fighter")?;
                if f.team == 0 {
                    self.save.selected = id;
                    self.save.destination = None
                } else {
                    self.save.target = Some(id)
                }
            }
            Command::Target { id } => {
                self.save.battle.fighter(id).ok_or("Unknown target")?;
                self.save.target = Some(id);
            }
            Command::Destination { q, r } => {
                let p = Hex { q, r };
                if !self.save.battle.inboard(p) {
                    return Err("Outside the battlefield".into());
                }
                self.save.destination = Some(p);
            }
            Command::Clear => {
                if self.save.battle.resolving {
                    return Err("Round already committed".into());
                }
                let selected = self.save.selected;
                self.save.draft.actions.retain(|a| a.actor != selected);
                self.save.draft.parry.remove(&self.save.selected);
            }
            Command::Declare {
                phase,
                activity,
                kind,
                spell,
                parry,
            } => {
                let f = self
                    .save
                    .battle
                    .fighter(self.save.selected)
                    .ok_or("Select a fighter")?;
                let target = self.save.target.ok_or("Select a target")?;
                let spell = spell.unwrap_or(Spell::HealingI);
                let mut from = f.pos;
                for a in &self.save.draft.actions {
                    if a.actor == f.id && a.phase < phase {
                        if let Action::Move { path } | Action::Disengage { path } = &a.action {
                            from = path.last().copied().unwrap_or(from);
                        }
                    }
                }
                let action = match kind.as_str() {
                    "Press" => Action::Press { target },
                    "React" => Action::React { target: None },
                    "Move" | "Disengage" => {
                        let to = self.save.destination.ok_or("Tap a destination hex first")?;
                        let route = path(&self.save.battle, f.id, to, from);
                        if route.is_empty() {
                            return Err("No open path to that destination".into());
                        }
                        if kind == "Move" {
                            Action::Move { path: route }
                        } else {
                            Action::Disengage { path: route }
                        }
                    }
                    "Melee" => Action::Melee { target },
                    "Missile" => Action::Missile { target },
                    "Prepare" => Action::Prepare { spell },
                    "Cast" => Action::Cast {
                        spell,
                        target: if spell == Spell::Blur { f.id } else { target },
                    },
                    "Reload" => Action::Reload,
                    "ChangeWeapon" => Action::ChangeWeapon {
                        index: (f.weapon + 1) % f.weapons.len(),
                    },
                    "Wait" => Action::Wait,
                    _ => return Err("Unknown action".into()),
                };
                let mut draft = self.save.draft.clone();
                draft
                    .actions
                    .retain(|a| !(a.actor == f.id && a.phase == phase));
                draft.actions.push(ActionDeclaration {
                    actor: f.id,
                    phase,
                    activity,
                    action,
                });
                if parry > 0 {
                    draft.parry.insert(
                        f.id,
                        Parry {
                            target,
                            amount: parry,
                        },
                    );
                } else {
                    draft.parry.remove(&f.id);
                }
                self.save.battle.validate_plan(&draft, Some(0))?;
                self.save.draft = draft;
            }
            Command::Commit => {
                if self.replay.is_some() {
                    return Err("Close replay before committing".into());
                }
                self.save.battle.validate_plan(&self.save.draft, Some(0))?;
                let mut plan = self.save.draft.clone();
                plan.actions.extend(self.save.ai.actions.clone());
                plan.parry.extend(self.save.ai.parry.clone());
                self.save.battle.commit(plan)?;
                self.paused = false;
                self.last = get_time();
            }
            Command::Step => {
                self.paused = true;
                self.step()?;
            }
            Command::Freeze => {
                self.paused = true;
            }
            Command::Motion { reduced } => {
                self.reduced_motion = reduced;
            }
            Command::Pause => {
                self.paused = !self.paused;
                self.last = get_time();
            }
            Command::Speed { seconds } => self.seconds = seconds.clamp(0.1, 3.),
            Command::Restart { scenario, seed } => {
                let revision = self.revision;
                let reduced = self.reduced_motion;
                *self = Self::new(scenario, seed)?;
                self.reduced_motion = reduced;
                self.revision = revision;
            }
            Command::Restore { save } => {
                if save.version != 1
                    || save.scenario >= scenarios().len()
                    || save.history.len() > 10000
                {
                    return Err("Unsupported or invalid skirmish save".into());
                }
                save.battle.validate_state()?;
                if !save.battle.resolving && !save.battle.finished {
                    save.battle.validate_plan(&save.draft, Some(0))?;
                    save.battle.validate_plan(&save.ai, Some(1))?;
                }
                self.save = save;
                self.paused = true;
                self.replay = None;
            }
            Command::Replay { index } => {
                if index.is_some_and(|i| i >= self.save.history.len()) {
                    return Err("No such replay frame".into());
                }
                self.paused = true;
                self.replay = index;
            }
        }
        Ok(())
    }
    fn dispatch(&mut self, c: Command) {
        self.error = match self.command(c) {
            Ok(()) => String::new(),
            Err(e) => e,
        };
        self.revision += 1;
        self.publish();
    }
    fn draw(&self) {
        clear_background(Color::from_rgba(27, 37, 37, 255));
        let (w, h) = (screen_width(), screen_height());
        let size = (w / 18.).min(h / 13.).max(10.);
        let origin = vec2(w / 2., h / 2.);
        let point = |p: Hex| origin + geom::hex_to_point(size, pos(p));
        let a = assets::get();
        let texture = |t: Texture2D, p: Vec2, _width: f32, height: f32, tint: Color| {
            let width = height * t.width() / t.height();
            draw_texture_ex(
                t,
                p.x - width / 2.,
                p.y - height / 2.,
                tint,
                DrawTextureParams {
                    dest_size: Some(vec2(width, height)),
                    ..Default::default()
                },
            )
        };
        for r in -self.save.battle.radius..=self.save.battle.radius {
            for q in -self.save.battle.radius..=self.save.battle.radius {
                let p = Hex { q, r };
                if !self.save.battle.inboard(p) {
                    continue;
                }
                let v = point(p);
                texture(a.textures.map.tile, v, size * 1.78, size * 1.625, WHITE);
                if self.save.battle.walls.contains(&p) {
                    let t = a.sprite_frames[&ObjType::from("boulder")][""];
                    texture(t, v - vec2(0., size * 0.35), size * 1.7, size * 1.7, WHITE);
                }
                if self.save.destination == Some(p) {
                    draw_circle_lines(v.x, v.y, size * 0.5, 2., GOLD);
                }
            }
        }
        for declaration in &self.save.draft.actions {
            if let Action::Move { path } | Action::Disengage { path } = &declaration.action {
                for p in path {
                    let v = point(*p);
                    draw_circle(v.x, v.y, 3., GOLD);
                }
            }
        }
        let fighters = self.replay.map_or(&self.save.battle.fighters, |i| {
            &self.save.history[i].fighters
        });
        let recent = self.save.battle.events.last();
        for f in fighters {
            let mut v = point(f.pos);
            let elapsed = (get_time() - self.last) as f32;
            if self.replay.is_none() && !self.reduced_motion {
                if let Some(e) = recent {
                    if e.actor == Some(f.id) && e.kind == "move" && elapsed < self.seconds {
                        if let (Some(from), Some(to)) = (e.from, e.to) {
                            v = point(from).lerp(point(to), (elapsed / self.seconds).clamp(0., 1.));
                        }
                    }
                }
            }
            if f.id == self.save.selected || self.save.target == Some(f.id) {
                texture(
                    a.textures.map.selection,
                    v,
                    size * 1.8,
                    size * 1.5,
                    if f.team == 0 {
                        Color::new(0.4, 0.85, 1., 1.)
                    } else {
                        Color::new(1., 0.4, 0.3, 1.)
                    },
                );
            }
            let name = match f.id {
                1 => "swordsman",
                2 => "healer",
                3 => "firer",
                4 => "alchemist",
                11 => "imp",
                12 => "imp_bomber",
                13 => "toxic_imp",
                _ => "imp_summoner",
            };
            let frames = &a.sprite_frames[&ObjType::from(name)];
            let t = frames[""];
            let tint = if f.conscious() {
                WHITE
            } else {
                Color::new(0.5, 0.5, 0.5, 0.35)
            };
            texture(a.textures.map.shadow, v, size * 1.4, size * 0.5, WHITE);
            texture(t, v - vec2(0., size * 0.55), size * 1.6, size * 2., tint);
            let bar = size * 1.3;
            draw_rectangle(
                v.x - bar / 2.,
                v.y + size * 0.32,
                bar,
                4.,
                Color::new(0.1, 0.1, 0.1, 1.),
            );
            draw_rectangle(
                v.x - bar / 2.,
                v.y + size * 0.32,
                bar * ((f.max_hits - f.damage).max(0) as f32 / f.max_hits as f32),
                4.,
                if f.team == 0 { GREEN } else { ORANGE },
            );
            draw_text(
                &f.id.to_string(),
                v.x - 5.,
                v.y + size * 0.85,
                (size * 0.65).max(12.),
                WHITE,
            );
        }
        if is_mouse_button_pressed(MouseButton::Left) && self.replay.is_none() {
            let (x, y) = mouse_position();
            let p = hex(geom::point_to_hex(size, vec2(x, y) - origin));
            if self.save.battle.inboard(p) {
                let cmd = if let Some(f) = self.save.battle.fighters.iter().find(|f| f.pos == p) {
                    Command::Select { id: f.id }
                } else {
                    Command::Destination { q: p.q, r: p.r }
                };
                INPUT.with(|q| q.borrow_mut().push(cmd));
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            draw_text(
                "1–4 select • Click enemy • A attack • M move • C commit • Space pause • N step",
                12.,
                22.,
                18.,
                WHITE,
            );
            draw_text(
                &format!("Round {} — {}", self.save.battle.round, self.error),
                12.,
                45.,
                20.,
                GOLD,
            );
            if let Some(e) = recent {
                draw_text(&e.text, 12., h - 15., 16., WHITE);
            }
        }
    }
}
pub async fn run() -> crate::ZResult {
    let mut game = Game::new(0, 2026).unwrap();
    game.publish();
    loop {
        let commands = INPUT.with(|q| std::mem::take(&mut *q.borrow_mut()));
        for c in commands {
            game.dispatch(c);
        }
        if !game.paused
            && game.save.battle.resolving
            && get_time() - game.last > game.seconds as f64
        {
            if let Err(e) = game.step() {
                game.error = e;
                game.paused = true;
            }
            game.revision += 1;
            game.publish();
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            for (key, id) in [
                (KeyCode::Key1, 1),
                (KeyCode::Key2, 2),
                (KeyCode::Key3, 3),
                (KeyCode::Key4, 4),
            ] {
                if is_key_pressed(key) {
                    game.dispatch(Command::Select { id });
                }
            }
            if is_key_pressed(KeyCode::A) {
                game.dispatch(Command::Declare {
                    phase: Phase::Normal,
                    activity: 100,
                    kind: "Melee".into(),
                    spell: None,
                    parry: 0,
                });
            }
            if is_key_pressed(KeyCode::M) {
                game.dispatch(Command::Declare {
                    phase: Phase::Deliberate,
                    activity: 80,
                    kind: "Move".into(),
                    spell: None,
                    parry: 0,
                });
            }
            if is_key_pressed(KeyCode::C) {
                game.dispatch(Command::Commit);
            }
            if is_key_pressed(KeyCode::Space) {
                game.dispatch(Command::Pause);
            }
            if is_key_pressed(KeyCode::N) {
                game.dispatch(Command::Step);
            }
        }
        game.draw();
        next_frame().await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_command_preserves_numeric_map_keys_and_rng() {
        let mut game = Game::new(0, 2026).unwrap();
        let plan = ai_plan_for_team(&game.save.battle, 0);
        game.save.battle.commit(plan).unwrap();
        let bytes =
            serde_json::to_vec(&serde_json::json!({"type":"Restore","save":game.save})).unwrap();
        match parse_command(&bytes).unwrap() {
            Command::Restore { save } => {
                assert_eq!(save.battle.rng, game.save.battle.rng);
                assert_eq!(save.battle.initiative, game.save.battle.initiative);
            }
            _ => panic!("wrong command"),
        }
    }
    #[test]
    fn scenarios_and_ai_are_valid() {
        for s in scenarios() {
            let b = BattleState::new(s.fighters, s.radius, s.walls, 2026).unwrap();
            b.validate_plan(&ai_plan(&b), Some(1)).unwrap();
        }
    }
    #[test]
    fn pathfinder_avoids_walls_and_units() {
        let s = scenarios().remove(1);
        let b = BattleState::new(s.fighters, s.radius, s.walls, 1).unwrap();
        let from = b.fighter(1).unwrap().pos;
        let p = path(&b, 1, Hex { q: 0, r: 0 }, from);
        assert!(!p.is_empty());
        for h in p {
            assert!(b.open(h, 1));
        }
    }
    #[test]
    fn all_three_scenarios_reach_a_result_with_shared_validation() {
        let data = DataPack::bundled();
        for s in scenarios() {
            let mut b = BattleState::new(s.fighters, s.radius, s.walls, 2026).unwrap();
            for _ in 0..150 {
                if b.finished {
                    break;
                }
                let mut p = ai_plan_for_team(&b, 0);
                p.actions.extend(ai_plan_for_team(&b, 1).actions);
                b.commit(p).unwrap();
                while b.resolving {
                    b.step(&data).unwrap();
                }
                b.validate_state().unwrap();
            }
            assert!(
                b.finished,
                "scenario {} did not finish by round {}",
                s.id, b.round
            );
        }
    }
    #[test]
    fn ai_is_independent_of_player_plan() {
        let s = scenarios().remove(0);
        let b = BattleState::new(s.fighters, s.radius, s.walls, 3).unwrap();
        assert_eq!(
            serde_json::to_string(&ai_plan(&b)).unwrap(),
            serde_json::to_string(&ai_plan(&b)).unwrap()
        );
    }
}
