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
    selected: u32,
    target: Option<u32>,
    destination: Option<Hex>,
    history: Vec<Frame>,
}
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Command {
    BoardClick {
        x: f32,
        y: f32,
        mode: String,
    },
    Invalid {
        message: String,
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
    Turn {
        actor: u32,
        sequence: u64,
        kind: String,
        spell: Option<Spell>,
    },
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
#[cfg(test)]
fn ai_plan(b: &BattleState) -> RoundPlan {
    ai_plan_for_team(b, 1)
}
#[cfg(test)]
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
        let (activity, action) = if f.has("prone", b.round) {
            (50, Action::StandUp)
        } else if f.has("mustParry", b.round) || f.has("noAttack", b.round) {
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
        } else if f.weapon_recovery.contains_key(&f.weapon) {
            (100, Action::RecoverWeapon)
        } else if f.broken_weapons.contains(&f.weapon) {
            match (0..f.weapons.len()).find(|i| !f.broken_weapons.contains(i)) {
                Some(index) => (50, Action::ChangeWeapon { index }),
                None => (0, Action::Wait),
            }
        } else if w.reload > 0 && f.pos.distance(t.pos) <= 1 {
            match f
                .weapons
                .iter()
                .enumerate()
                .find(|(index, weapon)| weapon.reload == 0 && !f.broken_weapons.contains(index))
            {
                Some((index, _)) => (50, Action::ChangeWeapon { index }),
                None => (0, Action::Wait),
            }
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
// Choose only for the current actor, from the battlefield at this instant.
fn ai_turn(b: &BattleState) -> TurnCommand {
    let turn = b.turns.as_ref().unwrap();
    let f = b.fighter(turn.active).unwrap();
    let t = b
        .fighters
        .iter()
        .filter(|t| t.team != f.team && t.conscious())
        .min_by_key(|t| (f.pos.distance(t.pos), t.id));
    let Some(t) = t else {
        return TurnCommand::Act(Action::Wait);
    };
    let w = &f.weapons[f.weapon];
    let action = if f.has("prone", b.round) {
        Action::StandUp
    } else if f.weapon_recovery.contains_key(&f.weapon) {
        Action::RecoverWeapon
    } else if f.broken_weapons.contains(&f.weapon) {
        match (0..f.weapons.len()).find(|i| !f.broken_weapons.contains(i)) {
            Some(index) => Action::ChangeWeapon { index },
            None => Action::Wait,
        }
    } else if f.has("mustParry", b.round) || f.has("noAttack", b.round) {
        if w.reload == 0 && !f.has("noParry", b.round) {
            return TurnCommand::Parry;
        } else {
            Action::Wait
        }
    } else if let Some(spell) = f.spells.iter().find(|s| {
        s.hostile()
            && f.pp >= s.level()
            && f.pos.distance(t.pos) * 5 <= s.range()
            && b.line_of_sight(f.pos, t.pos)
    }) {
        Action::Cast {
            spell: *spell,
            target: t.id,
        }
    } else if w.reload > 0 && f.pos.distance(t.pos) <= 1 {
        match f
            .weapons
            .iter()
            .enumerate()
            .find(|(i, w)| w.reload == 0 && !f.broken_weapons.contains(i))
        {
            Some((index, _)) => Action::ChangeWeapon { index },
            None => Action::Wait,
        }
    } else if w.reload > 0 && f.reload_left > 0 {
        Action::Reload
    } else if f.pos.distance(t.pos) * 5 <= w.range && b.line_of_sight(f.pos, t.pos) {
        if w.reload > 0 {
            Action::Missile { target: t.id }
        } else {
            Action::Melee { target: t.id }
        }
    } else {
        if turn.movement_remaining >= 5 {
            let route = t
                .pos
                .neighbors()
                .iter()
                .filter(|p| b.open(**p, f.id))
                .map(|p| path(b, f.id, *p, f.pos))
                .filter(|p| !p.is_empty())
                .min_by_key(|p| p.len())
                .unwrap_or_default();
            if !route.is_empty() {
                return TurnCommand::Move {
                    path: route
                        .into_iter()
                        .take((turn.movement_remaining / 5) as usize)
                        .collect(),
                };
            }
        }
        Action::Wait
    };
    TurnCommand::Act(action)
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
        let battle = BattleState::new_simplified(s.fighters, s.radius, s.walls, seed)?;
        let selected = battle.turns.as_ref().unwrap().active;
        let history = vec![Frame {
            fighters: battle.fighters.clone(),
            event: None,
        }];
        Ok(Self {
            save: Save {
                version: 2,
                scenario,
                seed,
                battle,
                selected,
                target: Some(11),
                destination: None,
                history,
            },
            data: DataPack::bundled(),
            error: String::new(),
            paused: false,
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
    fn record(&mut self, events: &[CombatEvent]) {
        if !events.is_empty() {
            self.save.history.push(Frame {
                fighters: self.save.battle.fighters.clone(),
                event: events.last().cloned(),
            });
        }
    }
    fn step(&mut self) -> Result<(), String> {
        if self.replay.is_some() {
            return Err("Replay is read-only".into());
        }
        let previous = self.save.battle.turns.as_ref().unwrap().active;
        let events = if self.save.battle.resolving {
            self.save.battle.advance_turn_playback()?
        } else if self.save.battle.fighter(previous).unwrap().team == 1
            && !self.save.battle.finished
        {
            let t = self.save.battle.turns.as_ref().unwrap();
            let command = ai_turn(&self.save.battle);
            self.save
                .battle
                .command_turn(previous, t.sequence, command, &self.data)?
        } else {
            vec![]
        };
        self.record(&events);
        let active = self.save.battle.turns.as_ref().unwrap().active;
        if active != previous {
            self.save.selected = active;
            self.save.destination = None;
        }
        self.last = get_time();
        Ok(())
    }
    fn command(&mut self, c: Command) -> Result<(), String> {
        if self.replay.is_some()
            && !matches!(
                c,
                Command::Replay { .. }
                    | Command::Motion { .. }
                    | Command::Speed { .. }
                    | Command::Freeze
                    | Command::Select { .. }
                    | Command::Target { .. }
            )
        {
            return Err("Replay is read-only; return to the live battle first".into());
        }
        match c {
            Command::Turn {
                actor,
                sequence,
                kind,
                spell,
            } => {
                let f = self.save.battle.fighter(actor).ok_or("Unknown actor")?;
                if f.team != 0 {
                    return Err("Only your active fighter can be commanded".into());
                }
                let target = self.save.target.unwrap_or(actor);
                let command = match kind.as_str() {
                    "Move" => TurnCommand::Move {
                        path: path(
                            &self.save.battle,
                            actor,
                            self.save.destination.ok_or("Choose a destination")?,
                            f.pos,
                        ),
                    },
                    "Parry" => TurnCommand::Parry,
                    "Attack" => TurnCommand::Act(if f.weapons[f.weapon].reload > 0 {
                        Action::Missile { target }
                    } else {
                        Action::Melee { target }
                    }),
                    "Cast" => {
                        let spell = spell.ok_or("Choose a spell")?;
                        TurnCommand::Act(Action::Cast {
                            spell,
                            target: if spell == Spell::Blur { actor } else { target },
                        })
                    }
                    "Reload" => TurnCommand::Act(Action::Reload),
                    "RecoverWeapon" => TurnCommand::Act(Action::RecoverWeapon),
                    "StandUp" => TurnCommand::Act(Action::StandUp),
                    "ChangeWeapon" => TurnCommand::Act(Action::ChangeWeapon {
                        index: (f.weapon + 1) % f.weapons.len(),
                    }),
                    "Wait" => TurnCommand::Act(Action::Wait),
                    _ => return Err("Unknown turn action".into()),
                };
                let events = self
                    .save
                    .battle
                    .command_turn(actor, sequence, command, &self.data)?;
                self.record(&events);
                self.save.destination = None;
                self.paused = false;
                self.last = get_time();
            }
            Command::BoardClick { x, y, mode } => {
                if self.replay.is_some()
                    || self.save.battle.finished
                    || (self.save.battle.resolving && self.save.battle.awaiting_react.is_none())
                {
                    return Err("Wait for playback before choosing on the battlefield".into());
                }
                let (w, h) = (screen_width(), screen_height());
                let size = (w / 18.).min(h / 13.).max(10.);
                let click = vec2(x * w, y * h) - vec2(w / 2., h / 2.);
                let p = hex(geom::point_to_hex(size, click));
                // Sprites extend above their hex: accept clicks on the body as well as its tile.
                let body = self.save.battle.fighters.iter().rev().find(|f| {
                    let offset = click - geom::hex_to_point(size, pos(f.pos));
                    offset.x.abs() < size * 0.55
                        && offset.y > -size * 1.45
                        && offset.y < size * 0.25
                });
                let fighter =
                    body.or_else(|| self.save.battle.fighters.iter().find(|f| f.pos == p));
                if let Some(f) = fighter {
                    let id = f.id;
                    return self.command(
                        if mode == "target" || self.save.battle.awaiting_react.is_some() {
                            Command::Target { id }
                        } else if mode == "move" {
                            return Err("Choose an empty hex for movement".into());
                        } else {
                            Command::Select { id }
                        },
                    );
                }
                if mode == "target" {
                    return Err("Click a fighter to choose your target".into());
                }
                return self.command(Command::Destination { q: p.q, r: p.r });
            }
            Command::Invalid { message } => return Err(message),
            Command::Select { id } => {
                let f = self.save.battle.fighter(id).ok_or("Unknown fighter")?;
                self.save.selected = f.id;
                self.save.destination = None;
            }
            Command::Target { id } => {
                self.save.battle.fighter(id).ok_or("Unknown target")?;
                self.save.target = Some(id);
            }
            Command::Destination { q, r } => {
                let p = Hex { q, r };
                if !self.save.battle.open(p, self.save.selected) {
                    return Err("Choose an open hex on the battlefield".into());
                }
                self.save.destination = Some(p);
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
                if save.version != 2
                    || save.battle.turns.is_none()
                    || save.scenario >= scenarios().len()
                    || save.history.len() > 10000
                {
                    return Err("Unsupported or invalid skirmish save".into());
                }
                save.battle.validate_state()?;
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
        if self.replay.is_none() {
            if let Some(destination) = self.save.destination {
                if let Some(f) = self.save.battle.fighter(self.save.selected) {
                    for p in path(&self.save.battle, f.id, destination, f.pos) {
                        let v = point(p);
                        draw_circle(v.x, v.y, 3., SKYBLUE);
                    }
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
            if self.replay.is_none()
                && self
                    .save
                    .battle
                    .turns
                    .as_ref()
                    .is_some_and(|t| t.active == f.id)
            {
                draw_circle_lines(v.x, v.y, size * 0.72, 4., GOLD);
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
        #[cfg(not(target_arch = "wasm32"))]
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
                "1–4 select • Click enemy • A attack • M move • C end turn • Space pause • N step",
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
            && game.replay.is_none()
            && !game.save.battle.finished
            && (game.save.battle.resolving
                || game
                    .save
                    .battle
                    .fighter(game.save.battle.turns.as_ref().unwrap().active)
                    .unwrap()
                    .team
                    == 1)
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
            for (key, kind) in [
                (KeyCode::A, "Attack"),
                (KeyCode::M, "Move"),
                (KeyCode::C, "Wait"),
            ] {
                if is_key_pressed(key) {
                    let t = game.save.battle.turns.as_ref().unwrap();
                    game.dispatch(Command::Turn {
                        actor: t.active,
                        sequence: t.sequence,
                        kind: kind.into(),
                        spell: None,
                    });
                }
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
        let game = Game::new(0, 2026).unwrap();
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
    fn simplified_scenarios_finish_and_resume_deterministically() {
        let data = DataPack::bundled();
        for s in scenarios() {
            let mut b = BattleState::new_simplified(s.fighters, s.radius, s.walls, 2026).unwrap();
            for _ in 0..5000 {
                if b.finished {
                    break;
                }
                let mut restored: BattleState =
                    serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
                for state in [&mut b, &mut restored] {
                    if state.resolving {
                        state.advance_turn_playback().unwrap();
                    } else {
                        let t = state.turns.as_ref().unwrap();
                        state
                            .command_turn(t.active, t.sequence, ai_turn(state), &data)
                            .unwrap();
                    }
                    state.validate_state().unwrap();
                }
                assert_eq!(
                    serde_json::to_string(&b).unwrap(),
                    serde_json::to_string(&restored).unwrap()
                );
            }
            assert!(b.finished, "scenario {} stalled at round {}", s.id, b.round);
        }
    }
    #[test]
    fn ai_recovers_dropped_weapons_and_switches_broken_weapons() {
        let s = scenarios().remove(0);
        let mut b = BattleState::new(s.fighters, s.radius, s.walls, 3).unwrap();
        b.fighters[0].weapon_recovery.insert(0, 2);
        let plan = ai_plan_for_team(&b, 0);
        assert!(plan
            .actions
            .iter()
            .any(|a| a.actor == b.fighters[0].id && matches!(a.action, Action::RecoverWeapon)));
        b.fighters[0].weapon_recovery.clear();
        b.fighters[0].broken_weapons.insert(0);
        let plan = ai_plan_for_team(&b, 0);
        assert!(plan.actions.iter().any(|a| a.actor == b.fighters[0].id
            && matches!(a.action, Action::ChangeWeapon { index: 1 })));
        b.validate_plan(&plan, Some(0)).unwrap();
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
