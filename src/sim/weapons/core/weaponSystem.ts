/**
 * `WeaponSystem` (docs/DESIGN.md §5, §8.1): fire control for every pawn and
 * the projectiles in flight. One instance per world.
 *
 * Per tick the world calls, in this order:
 *
 * ```ts
 * for (const rec of pawnsAscending) {
 *   events.push(...tickPawn(rec, input, ctx));              // P12: life rules, switching
 *   events.push(...weapons.tickPawn(rec, input, tick));     // this: hold hooks, firing
 * }
 * events.push(...weapons.step(tick, inputs));               // this: projectiles
 * ```
 *
 * plus `onPawnDied` after any death (guided warheads detonate, §5.1) and
 * `removeOwner` from `World.removePlayer`. `projectileStates()` feeds the
 * snapshot.
 *
 * Firing rules: a living pawn holding a weapon that is not mid-switch fires
 * the held mode (primary wins over alt) once its cooldown has passed and it
 * can pay the mode's ammo; the weapon then switches away if it ran dry. Modes
 * with `loadMax` load while held and fire on release. While guiding a
 * projectile nothing fires and a Fire press detonates it. Weapon modules get
 * an `update` hook each tick and may replace any mode's behavior.
 */
import { canFire, consumeAmmo, switchIfEmpty } from '../../inventory';
import type { PawnRecord } from '../../pawn';
import {
  Buttons,
  NO_ENTITY,
  type EntityId,
  type FireModeDef,
  type InputCommand,
  type PawnId,
  type PawnState,
  type ProjectileState,
  type SimEvent,
  type Tick,
  type WeaponId,
} from '../../types';
import { BEHAVIORS } from './behaviors';
import {
  coolHeat,
  createPawnWeaponState,
  effectiveSpread,
  fanSalvoDirection,
  heatUp,
  loadMaxOf,
  loadTicks,
  rateTicks,
  spreadDirection,
} from './fireControl';
import { eyePosition } from './geometry';
import type {
  FireContext,
  FireMode,
  PawnWeaponState,
  ProjectileRecord,
  ProjectileSpawn,
  RemoveReason,
  WeaponHost,
  WeaponModule,
  WeaponServices,
} from './host';
import { directionFromAngles } from './math';
import {
  createProjectile,
  damageProjectile,
  detonateProjectile,
  stepProjectile,
  type ProjectileEnv,
} from './projectile';

export class WeaponSystem implements WeaponServices {
  private readonly modules = new Map<WeaponId, WeaponModule>();
  private readonly records = new Map<EntityId, ProjectileRecord>();
  private readonly pawnStates = new Map<PawnId, PawnWeaponState>();
  /** Inputs of the tick being stepped, for guidance. */
  private inputs: ReadonlyMap<PawnId, InputCommand> = new Map();

  constructor(
    readonly host: WeaponHost,
    modules: readonly WeaponModule[] = [],
  ) {
    for (const m of modules) this.register(m);
  }

  /** Install (or replace) the module for a weapon. */
  register(module: WeaponModule): void {
    this.modules.set(module.id, module);
  }

  module(weapon: WeaponId): WeaponModule | undefined {
    return this.modules.get(weapon);
  }

  /** Fire-control state for a pawn, created on first use. */
  stateFor(pawn: PawnId): PawnWeaponState {
    let s = this.pawnStates.get(pawn);
    if (!s) {
      s = createPawnWeaponState();
      this.pawnStates.set(pawn, s);
    }
    return s;
  }

  // -- Per-pawn firing ------------------------------------------------------

  /**
   * Run one pawn's weapon for this tick: the held weapon's `update` hook,
   * loading, and firing. Call after `tickPawn` from `src/sim/pawn.ts`.
   */
  tickPawn(rec: PawnRecord, input: Readonly<InputCommand>, tick: Tick): SimEvent[] {
    const events: SimEvent[] = [];
    const pawn = rec.state;
    const state = this.stateFor(pawn.id);

    const primaryDown = (input.buttons & Buttons.Fire) !== 0;
    const altDown = (input.buttons & Buttons.AltFire) !== 0;
    const pressed = {
      primary: primaryDown && !state.primaryWasDown,
      alt: altDown && !state.altWasDown,
    };
    state.primaryWasDown = primaryDown;
    state.altWasDown = altDown;

    if (!pawn.alive) {
      this.resetState(state, null);
      return events;
    }
    if (pawn.weapon !== state.heldWeapon) this.resetState(state, pawn.weapon);
    coolHeat(state);

    // Guiding a projectile: the body is frozen; Fire detonates (§5.1).
    if (pawn.guiding !== NO_ENTITY) {
      const guided = this.records.get(pawn.guiding);
      if (!guided) pawn.guiding = NO_ENTITY;
      else if (pressed.primary)
        detonateProjectile(guided, this.env(tick, events), guided.state.position);
      return events;
    }

    const weapon = pawn.weapon;
    if (weapon === null) return events;
    const module = this.modules.get(weapon);
    module?.update?.({
      host: this.host,
      services: this,
      tick,
      pawn,
      inventory: rec.inventory,
      state,
      weapon,
      input,
      pressed,
      events,
    });

    const weapons = this.host.weapons;

    // A pending switch (or a module that took the weapon away) releases a salvo.
    if (!canFire(pawn) || pawn.weapon !== weapon) {
      if (state.loading)
        this.fireShots(rec, state, weapon, state.loading.mode, state.loading.count, tick, events);
      state.loading = null;
      return events;
    }

    if (state.loading) {
      const loading = state.loading;
      const def = weapons[weapon][loading.mode];
      const held = loading.mode === 'primary' ? primaryDown : altDown;
      if (held) {
        if (loading.count < loadMaxOf(def) && tick >= loading.nextLoadTick) {
          if (consumeAmmo(pawn, weapon, def.ammoPerShot, weapons)) {
            loading.count++;
            loading.nextLoadTick = tick + loadTicks(def);
          }
        }
        return events;
      }
      state.loading = null;
      this.fireShots(rec, state, weapon, loading.mode, loading.count, tick, events);
      return events;
    }

    const mode: FireMode | null = primaryDown ? 'primary' : altDown ? 'alt' : null;
    if (mode === null || tick < state.nextFireTick) return events;
    const def = weapons[weapon][mode];
    if (def.behavior === 'none') return events;

    if (def.behavior === 'action') {
      const fn = module?.fire?.[mode];
      if (!fn) return events;
      if (!consumeAmmo(pawn, weapon, def.ammoPerShot, weapons)) return events;
      fn(this.fireContext(pawn, state, weapon, mode, def, tick, events, 0, 1));
      state.nextFireTick = tick + rateTicks(def);
      events.push(...switchIfEmpty(pawn, rec.inventory, tick, weapons));
      return events;
    }

    if (loadMaxOf(def) > 1) {
      if (!consumeAmmo(pawn, weapon, def.ammoPerShot, weapons)) return events;
      state.loading = { mode, count: 1, nextLoadTick: tick + loadTicks(def) };
      return events;
    }

    if (!consumeAmmo(pawn, weapon, def.ammoPerShot, weapons)) return events;
    this.fireShots(rec, state, weapon, mode, 1, tick, events);
    return events;
  }

  /** Fire `count` already-paid shots of `mode` and start the cooldown. */
  private fireShots(
    rec: PawnRecord,
    state: PawnWeaponState,
    weapon: WeaponId,
    mode: FireMode,
    count: number,
    tick: Tick,
    events: SimEvent[],
  ): void {
    const pawn = rec.state;
    const def = this.host.weapons[weapon][mode];
    const module = this.modules.get(weapon);
    const behavior = module?.fire?.[mode] ?? BEHAVIORS[def.behavior];
    if (!behavior) return;
    for (let index = 0; index < count; index++) {
      const ctx = this.fireContext(pawn, state, weapon, mode, def, tick, events, index, count);
      events.push({
        type: 'shotFired',
        tick,
        pawn: pawn.id,
        weapon,
        mode,
        origin: { ...ctx.origin },
        direction: { ...ctx.direction },
      });
      behavior(ctx);
    }
    heatUp(state);
    state.nextFireTick = tick + rateTicks(def);
    events.push(...switchIfEmpty(pawn, rec.inventory, tick, this.host.weapons));
  }

  private fireContext(
    shooter: PawnState,
    state: PawnWeaponState,
    weapon: WeaponId,
    mode: FireMode,
    def: Readonly<FireModeDef>,
    tick: Tick,
    events: SimEvent[],
    index: number,
    count: number,
  ): FireContext {
    const origin = eyePosition(shooter);
    const aim = directionFromAngles(shooter.yaw, shooter.pitch);
    const direction =
      count > 1
        ? (this.modules.get(weapon)?.salvoDirection ?? fanSalvoDirection)({
            host: this.host,
            shooter,
            def,
            mode,
            aim,
            index,
            count,
          })
        : spreadDirection(aim, effectiveSpread(def, state.heat), this.host.rng);
    return {
      host: this.host,
      services: this,
      tick,
      shooter,
      state,
      weapon,
      mode,
      def,
      origin,
      aim,
      direction,
      salvo: { index, count },
      events,
    };
  }

  private resetState(state: PawnWeaponState, weapon: WeaponId | null): void {
    state.loading = null;
    state.heat = 0;
    state.custom = {};
    state.heldWeapon = weapon;
  }

  // -- Projectiles ----------------------------------------------------------

  /** Advance every projectile by one tick, in ascending id order. */
  step(tick: Tick, inputs: ReadonlyMap<PawnId, InputCommand>): SimEvent[] {
    const events: SimEvent[] = [];
    this.inputs = inputs;
    const ids = [...this.records.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const rec = this.records.get(id);
      if (!rec || rec.spawnTick === tick) continue;
      stepProjectile(rec, this.env(tick, events, rec));
    }
    return events;
  }

  spawnProjectile(spawn: ProjectileSpawn, tick: Tick, events: SimEvent[]): ProjectileRecord {
    const rec = createProjectile(this.host, spawn, tick, events);
    this.records.set(rec.state.id, rec);
    if (rec.state.guided) {
      const owner = this.host.pawn(spawn.owner);
      if (owner) {
        owner.guiding = rec.state.id;
        events.push({ type: 'guidanceStarted', tick, pawn: owner.id, projectile: rec.state.id });
      }
    }
    return rec;
  }

  projectile(id: EntityId): ProjectileRecord | undefined {
    return this.records.get(id);
  }

  projectiles(): Iterable<ProjectileRecord> {
    return this.records.values();
  }

  projectilesOf(owner: PawnId): ProjectileRecord[] {
    return [...this.records.values()].filter((r) => r.state.owner === owner);
  }

  /** Snapshot states of every projectile, ascending id. */
  projectileStates(): ProjectileState[] {
    return [...this.records.values()].sort((a, b) => a.state.id - b.state.id).map((r) => r.state);
  }

  detonate(id: EntityId, tick: Tick, events: SimEvent[]): void {
    const rec = this.records.get(id);
    if (rec) detonateProjectile(rec, this.env(tick, events, rec), rec.state.position);
  }

  destroy(id: EntityId, tick: Tick, events: SimEvent[]): void {
    const rec = this.records.get(id);
    if (rec) this.remove(rec, 'destroyed', tick, events);
  }

  damageProjectile(
    id: EntityId,
    amount: number,
    byPawn: PawnId,
    tick: Tick,
    events: SimEvent[],
  ): boolean {
    const rec = this.records.get(id);
    return rec ? damageProjectile(rec, amount, byPawn, this.env(tick, events, rec)) : false;
  }

  // -- Pawn lifecycle -------------------------------------------------------

  /** A pawn died: its guided warhead detonates in place (§5.1); loading is dropped. */
  onPawnDied(pawn: PawnId, tick: Tick): SimEvent[] {
    const events: SimEvent[] = [];
    const state = this.pawnStates.get(pawn);
    if (state) state.loading = null;
    for (const rec of this.projectilesOf(pawn)) {
      if (rec.detonateOnOwnerDeath)
        detonateProjectile(rec, this.env(tick, events, rec), rec.state.position);
    }
    return events;
  }

  /** A participant left: every projectile they own is removed without detonating. */
  removeOwner(pawn: PawnId, tick: Tick): SimEvent[] {
    const events: SimEvent[] = [];
    for (const rec of this.projectilesOf(pawn)) this.remove(rec, 'ownerRemoved', tick, events);
    this.pawnStates.delete(pawn);
    return events;
  }

  // -- Internals ------------------------------------------------------------

  private env(tick: Tick, events: SimEvent[], rec?: ProjectileRecord): ProjectileEnv {
    return {
      host: this.host,
      services: this,
      tick,
      events,
      module: rec ? this.modules.get(rec.weapon) : undefined,
      ownerInput: rec ? this.inputs.get(rec.state.owner) : undefined,
      remove: (r, reason) => this.remove(r, reason, tick, events),
    };
  }

  private remove(
    rec: ProjectileRecord,
    reason: RemoveReason,
    tick: Tick,
    events: SimEvent[],
  ): void {
    if (!this.records.delete(rec.state.id)) return;
    const s = rec.state;
    const owner = this.host.pawn(s.owner);
    if (owner) {
      if (owner.guiding === s.id) {
        owner.guiding = NO_ENTITY;
        events.push({ type: 'guidanceEnded', tick, pawn: owner.id, projectile: s.id });
      }
      if (owner.disc === s.id) {
        owner.disc = NO_ENTITY;
        owner.viewingDisc = false;
      }
    }
    events.push({ type: 'entityDestroyed', tick, id: s.id, kind: 'projectile' });
    this.modules
      .get(rec.weapon)
      ?.onProjectileRemoved?.(rec, reason, { host: this.host, tick, events });
  }
}
