/**
 * Contracts v1 for the ut-tiny simulation.
 *
 * This file is the shared vocabulary that every other packet codes against:
 * inputs, weapon and pickup data, map descriptions, entity state, simulation
 * events, match state, and the `World` interface itself. It contains types and
 * constants only; behavior lives in the packets that implement it.
 *
 * Rules (docs/DESIGN.md §8.1, §10, §18.2):
 * - Nothing in here may reference Three.js, the DOM, or wall-clock time.
 * - Changing a contract is its own packet; implementation PRs never edit this
 *   file as a side effect.
 * - Section references (§n) point at docs/DESIGN.md.
 */

// ---------------------------------------------------------------------------
// Scalars and math
// ---------------------------------------------------------------------------

/** Simulation tick index. Starts at 0 when a match begins. */
export type Tick = number;

/** Seconds of simulation time (not wall-clock). */
export type Seconds = number;

/** Simulation runs at a fixed 60 Hz (§8.1). */
export const TICK_RATE = 60;

/** Duration of one tick in seconds. */
export const TICK_DT: Seconds = 1 / TICK_RATE;

/**
 * Identifier for any entity in the world. Allocated by the `World`, never by
 * the renderer or a controller. `0` is reserved and means "no entity".
 */
export type EntityId = number;

/** The null entity id. */
export const NO_ENTITY: EntityId = 0;

/** Entity id of a pawn (a player- or bot-controlled body). */
export type PawnId = EntityId;

/**
 * Stable identity of a participant across respawns: `'local'` for the local
 * player in single-player, `'bot:<n>'` for bots, or the transport's player id
 * in multiplayer (§10).
 */
export type PlayerId = string;

/** Plain vector, 1 unit = 1 meter at player scale (§3). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit quaternion (x, y, z, w). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Axis-aligned box. */
export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/** Position plus view angles, used for spawns and cameras. Angles in radians. */
export interface Pose {
  position: Vec3;
  yaw: number;
  pitch: number;
}

// ---------------------------------------------------------------------------
// Input (§8.2)
// ---------------------------------------------------------------------------

/**
 * Button bits for `InputCommand.buttons`. Each is a single tick's state:
 * "held" bits (Fire, Jump, Crouch, CamView) are set every tick they are down;
 * "edge" bits (the dodges) are set for exactly one tick by the controller.
 */
export const Buttons = {
  Fire: 1 << 0,
  AltFire: 1 << 1,
  Jump: 1 << 2,
  Crouch: 1 << 3,
  DodgeForward: 1 << 4,
  DodgeBack: 1 << 5,
  DodgeLeft: 1 << 6,
  DodgeRight: 1 << 7,
  Use: 1 << 8,
  /** Holding the translocator disc camera (§5.1). */
  CamView: 1 << 9,
  NextWeapon: 1 << 10,
  PrevWeapon: 1 << 11,
} as const;

export type ButtonBit = (typeof Buttons)[keyof typeof Buttons];

/** Mask of all dodge bits. */
export const DODGE_BUTTONS: number =
  Buttons.DodgeForward | Buttons.DodgeBack | Buttons.DodgeLeft | Buttons.DodgeRight;

/**
 * One tick of intent from any controller: local player, bot, or a remote
 * player relayed over the network. The simulation knows nothing else about
 * where a command came from (§8.2).
 */
export interface InputCommand {
  /** Monotonic per-controller sequence number; used for network ordering and reconciliation. */
  seq: number;
  /** Strafe axis, -1 (left) .. 1 (right). */
  moveX: number;
  /** Forward axis, -1 (back) .. 1 (forward). */
  moveY: number;
  /** Absolute view yaw in radians. While guiding a Redeemer this is a steering command (§5.1). */
  yaw: number;
  /** Absolute view pitch in radians, clamped by the sim to ±(π/2 − ε). */
  pitch: number;
  /** Bitmask of `Buttons`. */
  buttons: number;
  /** Requested weapon slot 1–8, or 0 for no change. */
  weapon: number;
}

/** A command that does nothing; used for pawns whose controller produced nothing this tick. */
export const NULL_INPUT: Readonly<InputCommand> = Object.freeze({
  seq: 0,
  moveX: 0,
  moveY: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  weapon: 0,
});

/**
 * Anything that produces an `InputCommand` for a pawn each tick. Players, bots
 * and remote-input replay all implement this, so the sim treats them alike.
 */
export interface Controller {
  readonly pawnId: PawnId;
  /** Produce this tick's command. `state` is read-only and reflects the previous tick. */
  produce(tick: Tick, state: Readonly<WorldState>): InputCommand;
}

// ---------------------------------------------------------------------------
// Weapons (§5)
// ---------------------------------------------------------------------------

/** Stable weapon identifiers. Display names live in `src/data/strings`. */
export const WeaponIds = [
  'teleporter',
  'assault',
  'mines',
  'rocket',
  'sniper',
  'shock',
  'shockScoped',
  'redeemer',
] as const;

export type WeaponId = (typeof WeaponIds)[number];

/** Weapon bar slot, 1–8 in UT order (§5). */
export type WeaponSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * How a fire mode produces its effect. Each behavior is implemented once in the
 * weapon framework (P13) and parameterised by `FireModeDef`.
 */
export type FireBehavior =
  /** Instant ray; damage applied at the first hit (§5: assault bullets, sniper, shock beams). */
  | 'hitscan'
  /** Straight-flying projectile entity (rockets, Redeemer). */
  | 'projectile'
  /** Arcing, bouncing projectile with a fuse (grenades, mines before arming, translocator disc). */
  | 'lob'
  /** Alternate action with no projectile: teleport, detonate mines, toggle zoom, toggle load mode. */
  | 'action'
  /** Mode does nothing (e.g. Super Shock alt is the same beam, handled as a shared mode). */
  | 'none';

/** Optical zoom range for scoped alt fires (§5). */
export interface ZoomDef {
  min: number;
  max: number;
}

/** Tunables for one fire mode. All times in seconds, distances in meters, speeds in m/s. */
export interface FireModeDef {
  behavior: FireBehavior;
  /** Seconds between shots. */
  rate: Seconds;
  /** Ammo consumed per shot (0 for infinite-ammo weapons). */
  ammoPerShot: number;
  /** Direct-hit damage. */
  damage: number;
  /** Multiplier applied on headshots for hitscan modes (undefined = no headshots). */
  headshotMultiplier?: number;
  /** Projectile launch speed. */
  projectileSpeed?: number;
  /** Splash radius; damage falls off linearly to the edge. */
  splashRadius?: number;
  /** Damage at the center of the splash (defaults to `damage`). */
  splashDamage?: number;
  /** Knockback impulse scale applied with damage (§5 common rules). */
  momentum?: number;
  /** Fuse time for lobbed projectiles. */
  fuse?: Seconds;
  /** Spread half-angle in radians for hitscan/projectile modes. */
  spread?: number;
  /** Maximum projectiles that can be loaded by holding fire (rocket launcher: 3). */
  loadMax?: number;
  /** Seconds per additional loaded projectile. */
  loadTime?: Seconds;
  /** Zoom range if this mode toggles a scope. */
  zoom?: ZoomDef;
  /** Hit points of the projectile if it can be shot down (Redeemer warhead: 50). */
  projectileHealth?: number;
  /** Maximum simultaneously deployed entities per owner (mines: 4). */
  maxDeployed?: number;
}

/** Ammo configuration; `null` means infinite ammo. */
export interface AmmoDef {
  start: number;
  max: number;
  /** Amount granted by one ammo pickup. */
  perPickup: number;
}

/** Full definition of one weapon. The data table lives in `src/data/weapons.ts` (P13). */
export interface WeaponDef {
  id: WeaponId;
  slot: WeaponSlot;
  primary: FireModeDef;
  alt: FireModeDef;
  ammo: AmmoDef | null;
  /** Seconds to switch to this weapon (§5: 0.3). */
  switchTime: Seconds;
  /** Whether the pickup stays after being taken (§6). */
  weaponStay: boolean;
  /** Respawn delay when `weaponStay` is false (Redeemer: 60). */
  respawnSeconds?: Seconds;
  /** Relative strength for auto-switch and bot preference, higher is better. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Pickups (§6)
// ---------------------------------------------------------------------------

export type PickupType =
  'weapon' | 'ammo' | 'healthVial' | 'healthPack' | 'shieldPack' | 'superShield' | 'udamage';

/** Definition of a pickup kind. The table lives in `src/data/pickups.ts` (P18). */
export interface PickupDef {
  type: PickupType;
  /** For `weapon` and `ammo` pickups, which weapon. */
  weapon?: WeaponId;
  /** Health, shield, ammo or seconds granted. */
  amount: number;
  /** Upper bound the pickup can raise its stat to (health vial: 199, health pack: 100). */
  cap?: number;
  respawnSeconds: Seconds;
}

// ---------------------------------------------------------------------------
// Maps (§8.5)
// ---------------------------------------------------------------------------

/** Material key resolved by the renderer; the sim ignores it. */
export type MaterialId = string;

export type BrushShape = 'box' | 'cylinder' | 'ramp';

/** Primitive solid used for grey-box geometry and simple collision. */
export interface Brush {
  shape: BrushShape;
  /** Center position. */
  position: Vec3;
  /** Full extents (box), or x = diameter, y = height for cylinders. */
  size: Vec3;
  /** Rotation about the vertical axis, radians. */
  yaw?: number;
  material: MaterialId;
}

export type CollisionMode = 'box' | 'convex' | 'trimesh' | 'none';

/** Placed art asset; collision mode tells the physics glue how to approximate it. */
export interface PropRef {
  asset: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  collision: CollisionMode;
}

export interface PickupPlacement {
  type: PickupType;
  weapon?: WeaponId;
  position: Vec3;
}

export interface JumpPadDef {
  position: Vec3;
  /** Trigger extents. */
  size: Vec3;
  /** Velocity set on the pawn when it enters the pad. */
  launch: Vec3;
}

export type VolumeKind = 'kill' | 'damage' | 'water';

export interface VolumeDef {
  kind: VolumeKind;
  box: Box3;
  /** For `damage` volumes. */
  damagePerSecond?: number;
  /** Death message key for `kill` volumes (e.g. "flushed", "sumped"). */
  deathMessage?: string;
}

export type LightKind = 'point' | 'spot' | 'directional' | 'ambient';

export interface LightDef {
  kind: LightKind;
  position?: Vec3;
  direction?: Vec3;
  /** Color temperature in kelvin (§7 art direction); the renderer converts to RGB. */
  temperatureK: number;
  intensity: number;
  castShadow?: boolean;
}

/** Off-mesh connection hint for the navmesh bake (§9). */
export type NavLinkKind = 'jump' | 'doubleJump' | 'pad' | 'drop' | 'translocate';

export interface NavLinkDef {
  from: Vec3;
  to: Vec3;
  kind: NavLinkKind;
}

/** Named camera for screenshot scripts and debug views (§18.3). */
export interface CameraDef {
  name: string;
  pose: Pose;
}

export interface AmbienceDef {
  /** Looping ambient sound asset keys. */
  loops: string[];
  /** Reverb preset key. */
  reverb: string;
}

/**
 * Declarative description of a map. One file feeds the collision world, the
 * render scene, the navmesh bake and the Blender exporter (§8.5).
 */
export interface MapDef {
  name: string;
  /** Real-world to game scale factor (§3: 40). */
  scale: number;
  brushes: Brush[];
  props: PropRef[];
  spawns: Pose[];
  pickups: PickupPlacement[];
  jumpPads: JumpPadDef[];
  volumes: VolumeDef[];
  lights: LightDef[];
  navLinks: NavLinkDef[];
  cameras: CameraDef[];
  ambience: AmbienceDef;
}

// ---------------------------------------------------------------------------
// Damage (§5 common rules, §6)
// ---------------------------------------------------------------------------

export type DamageType =
  | 'bullet'
  | 'grenade'
  | 'mine'
  | 'rocket'
  | 'sniper'
  | 'shock'
  | 'redeemer'
  | 'telefrag'
  | 'fall'
  | 'killVolume'
  | 'damageVolume'
  | 'suicide';

/** Default and maximum pawn stats (§6). */
export const PAWN_STATS = {
  health: 100,
  healthMax: 199,
  shieldMax: 150,
  /** Health above 100 decays at this rate per second. */
  overhealDecayPerSecond: 1,
  /** Fraction of own splash damage taken. */
  selfDamageScale: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Entity state (what the sim exposes; what the renderer reads)
// ---------------------------------------------------------------------------

export type EntityKind = 'pawn' | 'projectile' | 'mine' | 'pickup' | 'jumpPad' | 'volume';

export interface EntityBase {
  id: EntityId;
  kind: EntityKind;
  position: Vec3;
}

export interface PawnState extends EntityBase {
  kind: 'pawn';
  playerId: PlayerId;
  alive: boolean;
  health: number;
  shield: number;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  /** Currently held weapon, or null before the first pickup. */
  weapon: WeaponId | null;
  /** Weapon being switched to during the switch delay, if any. */
  pendingWeapon: WeaponId | null;
  owned: WeaponId[];
  ammo: Partial<Record<WeaponId, number>>;
  /** Tick until which spawn protection lasts. */
  spawnProtectedUntil: Tick;
  /** Tick at which this dead pawn may respawn. */
  respawnAt: Tick;
  /** Projectile being guided (Redeemer alt), else NO_ENTITY (§5.1). */
  guiding: EntityId;
  /** Deployed translocator disc, else NO_ENTITY. */
  disc: EntityId;
  /** True while the pawn holds the disc-camera button and a disc is out (§5.1). */
  viewingDisc: boolean;
  /** Current optical zoom factor, 1 when unzoomed. */
  zoom: number;
  /** Tick until which UDamage applies, or 0. */
  udamageUntil: Tick;
}

export type ProjectileType = 'rocket' | 'grenade' | 'redeemer' | 'disc';

export interface ProjectileState extends EntityBase {
  kind: 'projectile';
  projectileType: ProjectileType;
  owner: PawnId;
  velocity: Vec3;
  orientation: Quat;
  /** Remaining hit points for shoot-down-able projectiles, else 0. */
  health: number;
  /** True while being steered by its owner (Redeemer alt). */
  guided: boolean;
  /** Translocator disc at rest. */
  landed: boolean;
  /** Translocator disc disrupted by enemy fire (§16 decision 3). */
  disrupted: boolean;
  /** Tick at which a fused projectile detonates, or 0. */
  detonateAt: Tick;
}

export interface MineState extends EntityBase {
  kind: 'mine';
  owner: PawnId;
  /** Armed one second after landing (§5). */
  armed: boolean;
}

export interface PickupState extends EntityBase {
  kind: 'pickup';
  /** Index into `MapDef.pickups`. */
  placementIndex: number;
  type: PickupType;
  weapon?: WeaponId;
  available: boolean;
  /** Tick at which the pickup returns if unavailable. */
  respawnAt: Tick;
  /** Pawns that have taken a weapon-stay pickup this life. */
  takenBy: PawnId[];
}

export interface JumpPadState extends EntityBase {
  kind: 'jumpPad';
  placementIndex: number;
}

export interface VolumeState extends EntityBase {
  kind: 'volume';
  placementIndex: number;
  volumeKind: VolumeKind;
}

export type EntityState =
  PawnState | ProjectileState | MineState | PickupState | JumpPadState | VolumeState;

// ---------------------------------------------------------------------------
// Match state and rules (§6)
// ---------------------------------------------------------------------------

export type MatchPhase = 'warmup' | 'countdown' | 'playing' | 'overtime' | 'ended';

export interface PlayerScore {
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  frags: number;
  deaths: number;
  suicides: number;
  /** Current killing-spree length. */
  spree: number;
}

export interface MatchState {
  phase: MatchPhase;
  /** 0 disables the limit. */
  fragLimit: number;
  /** Seconds; 0 disables the limit. */
  timeLimit: Seconds;
  elapsed: Seconds;
  scores: PlayerScore[];
  /** Set when `phase` is `ended`. */
  winner: PlayerId | null;
}

export interface RulesConfig {
  fragLimit: number;
  timeLimit: Seconds;
  weaponStay: boolean;
  /** Seconds of post-spawn invulnerability, ended early by firing. */
  spawnProtection: Seconds;
  /** Minimum seconds dead before respawn is allowed. */
  respawnDelay: Seconds;
  udamageEnabled: boolean;
}

/** Announcer lines (§6). Audio assets are keyed by these names. */
export type AnnouncerLine =
  | 'firstBlood'
  | 'doubleKill'
  | 'multiKill'
  | 'megaKill'
  | 'ultraKill'
  | 'monsterKill'
  | 'killingSpree'
  | 'rampage'
  | 'dominating'
  | 'unstoppable'
  | 'godlike'
  | 'headshot'
  | 'redeemerAvailable'
  | 'threeFragsLeft'
  | 'twoFragsLeft'
  | 'oneFragLeft'
  | 'countdown3'
  | 'countdown2'
  | 'countdown1'
  | 'play'
  | 'overtime'
  | 'youWin'
  | 'youLose';

// ---------------------------------------------------------------------------
// Simulation events (§8.1)
// ---------------------------------------------------------------------------

/**
 * Discrete things that happened during a tick. The renderer and audio consume
 * them for effects; the rules module consumes `death` and `pickupTaken`; the
 * network layer forwards them to clients alongside snapshots (§10). Every event
 * carries the tick it occurred on.
 */
export type SimEvent =
  | { type: 'entitySpawned'; tick: Tick; id: EntityId; kind: EntityKind }
  | { type: 'entityDestroyed'; tick: Tick; id: EntityId; kind: EntityKind }
  | {
      type: 'shotFired';
      tick: Tick;
      pawn: PawnId;
      weapon: WeaponId;
      mode: 'primary' | 'alt';
      origin: Vec3;
      direction: Vec3;
    }
  | {
      /** Hitscan trace result, for beams and tracers. */
      type: 'hitscan';
      tick: Tick;
      pawn: PawnId;
      weapon: WeaponId;
      from: Vec3;
      to: Vec3;
      hitPawn: PawnId;
      headshot: boolean;
    }
  | {
      type: 'explosion';
      tick: Tick;
      position: Vec3;
      radius: number;
      damageType: DamageType;
      instigator: PawnId;
    }
  | {
      type: 'damage';
      tick: Tick;
      target: PawnId;
      instigator: PawnId;
      amount: number;
      damageType: DamageType;
      /** Direction the damage pushed the target, for HUD indicators. */
      momentum: Vec3;
    }
  | {
      type: 'death';
      tick: Tick;
      victim: PawnId;
      /** NO_ENTITY for environmental deaths. */
      killer: PawnId;
      damageType: DamageType;
      weapon: WeaponId | null;
      /** Death-message key from a kill volume, if any. */
      message?: string;
    }
  | { type: 'respawn'; tick: Tick; pawn: PawnId; pose: Pose }
  | { type: 'pickupTaken'; tick: Tick; pawn: PawnId; pickup: EntityId; pickupType: PickupType }
  | { type: 'pickupRespawned'; tick: Tick; pickup: EntityId; pickupType: PickupType }
  | { type: 'weaponSwitched'; tick: Tick; pawn: PawnId; weapon: WeaponId }
  | { type: 'jumpPad'; tick: Tick; pawn: PawnId; pad: EntityId }
  | { type: 'footstep'; tick: Tick; pawn: PawnId; position: Vec3 }
  | { type: 'jump'; tick: Tick; pawn: PawnId; double: boolean }
  | { type: 'dodge'; tick: Tick; pawn: PawnId; wall: boolean }
  | { type: 'land'; tick: Tick; pawn: PawnId; impactSpeed: number }
  | {
      type: 'teleport';
      tick: Tick;
      pawn: PawnId;
      from: Vec3;
      to: Vec3;
      telefragged: PawnId;
    }
  | { type: 'projectileDestroyed'; tick: Tick; id: EntityId; byPawn: PawnId }
  | { type: 'discDisrupted'; tick: Tick; disc: EntityId; byPawn: PawnId }
  | { type: 'guidanceStarted'; tick: Tick; pawn: PawnId; projectile: EntityId }
  | { type: 'guidanceEnded'; tick: Tick; pawn: PawnId; projectile: EntityId }
  | {
      type: 'announcer';
      tick: Tick;
      line: AnnouncerLine;
      /** Pawn the line is addressed to, or NO_ENTITY for everyone. */
      toPawn: PawnId;
    }
  | { type: 'score'; tick: Tick; playerId: PlayerId; frags: number; deaths: number }
  | { type: 'matchPhase'; tick: Tick; phase: MatchPhase };

export type SimEventType = SimEvent['type'];

// ---------------------------------------------------------------------------
// World (§8.1)
// ---------------------------------------------------------------------------

/** Everything needed to reconstruct the renderer's view of a tick. */
export interface WorldState {
  tick: Tick;
  /** Simulation seconds since match start. */
  time: Seconds;
  /** `Rng.getState()` for replay and host migration. */
  rngState: number;
  entities: EntityState[];
  match: MatchState;
}

/** Profile supplied when a participant joins (§10). */
export interface PlayerProfile {
  name: string;
  isBot: boolean;
  /** Bot skill 0–7 (Novice..Godlike, §9); ignored for humans. */
  skill?: number;
}

export interface WorldOptions {
  map: MapDef;
  seed: number;
  rules: RulesConfig;
  weapons: Readonly<Record<WeaponId, WeaponDef>>;
  pickups: Readonly<Record<PickupType, PickupDef>>;
}

/**
 * The simulation. Pure with respect to its inputs: given the same options and
 * the same sequence of input maps, two `World`s produce the same states and
 * events. Owns entity ids and the RNG.
 */
export interface World {
  readonly tick: Tick;
  readonly options: Readonly<WorldOptions>;

  /**
   * Advance exactly one tick. Pawns absent from `inputs` receive `NULL_INPUT`.
   * Returns the events that occurred this tick, in order.
   */
  step(inputs: ReadonlyMap<PawnId, InputCommand>): readonly SimEvent[];

  /** Add a participant; their pawn is created dead and respawns per the rules. */
  addPlayer(playerId: PlayerId, profile: PlayerProfile): PawnId;

  /** Remove a participant and destroy their pawn and owned entities. */
  removePlayer(playerId: PlayerId): void;

  /** Pawn for a participant, or NO_ENTITY. */
  pawnFor(playerId: PlayerId): PawnId;

  /** Snapshot of the current state. Callers must treat it as read-only. */
  getState(): Readonly<WorldState>;

  /** Look up one entity, or undefined. */
  getEntity(id: EntityId): Readonly<EntityState> | undefined;
}

/**
 * Binary snapshot codec (§8.1, §10). Positions quantised to int16 centimeters,
 * orientations as smallest-three quaternions, health/ammo as small integers.
 * `decode(encode(s))` must equal `s` up to quantisation.
 */
export interface SnapshotCodec {
  encode(state: Readonly<WorldState>): ArrayBuffer;
  decode(buffer: ArrayBuffer): WorldState;
}
