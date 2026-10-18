/**
 * Kinematic character controller (docs/DESIGN.md §4, §8.1).
 *
 * One `CharacterMover` serves every pawn in a world; each pawn keeps its own
 * `MoverState`. `step()` takes one `InputCommand`, applies the UT movement
 * rules and moves the pawn's capsule through the `PhysicsWorld` with
 * shape casts: sweep → slide along surfaces → step up (≤ `stepHeight`) →
 * ground snap. Rapier integrates nothing; this file owns velocity, gravity
 * and the pawn's position, and writes the capsule center back to the physics
 * world at the end of each step so traces and sensors see it.
 *
 * `MoverState.position` is the capsule center, as in the physics glue and
 * the scene view; `feetPosition()` converts. Crouching shrinks the capsule
 * about its feet, so the center drops and rises with the height. Time is
 * counted in ticks for determinism.
 *
 * Input semantics (§8.2): Jump and Crouch are held bits; the controller only
 * acts on a Jump press (0 → 1). Dodge bits are one-tick edges produced by the
 * controller's double-tap detection, so a set dodge bit is a dodge request.
 */
import { PAWN_CAPSULE, PhysicsWorld, type CapsuleDims } from '../physics/physicsWorld';
import {
  Buttons,
  TICK_DT,
  TICK_RATE,
  type EntityId,
  type InputCommand,
  type SimEvent,
  type Tick,
  type Vec3,
} from '../types';
import { DEFAULT_MOVEMENT, type MovementConfig } from './config';
import {
  accelerateAir,
  accelerateGround,
  add,
  clampPitch,
  dodgeDirection,
  dot,
  fallDamage,
  groundAcceleration,
  horizontalSpeed,
  isWalkable,
  length,
  negate,
  projectOnPlane,
  scale,
  wishDirection,
} from './kinematics';

/** Why the pawn is off the ground. Decides what the next Jump press may do. */
export type AirborneCause = 'none' | 'jump' | 'dodge' | 'fall' | 'launch';

/** Per-pawn movement state. Plain data so it can live inside a pawn entity and be snapshotted. */
export interface MoverState {
  /** Capsule center, world space. */
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  /** Normal of the surface under the pawn when grounded, else +Y. */
  groundNormal: Vec3;
  crouching: boolean;
  airborne: AirborneCause;
  /** Tick of the current jump's takeoff; meaningful while `airborne === 'jump'`. */
  jumpTick: Tick;
  /** Tick at which the current jump reaches its apex. */
  apexTick: Tick;
  doubleJumped: boolean;
  /** A wall dodge has been used since the pawn last left the ground. */
  wallDodged: boolean;
  /** First tick at which the next dodge is allowed. */
  dodgeReadyTick: Tick;
  /** Jump bit from the previous tick, for press detection. */
  jumpWasDown: boolean;
  /** Ground distance walked since the last footstep. */
  footstepMeters: number;
}

export interface MoveResult {
  /** `jump`, `dodge`, `land` and `footstep` events for this tick, in order. */
  events: SimEvent[];
  /** Damage the landing dealt this tick (0 when none); the damage pipeline applies it. */
  fallDamage: number;
}

const UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });
const DOWN: Readonly<Vec3> = Object.freeze({ x: 0, y: -1, z: 0 });

/** Gap kept between the capsule and any surface so sweeps never start inside, m. */
const SKIN = 0.01;
/** Movement below this is treated as none, m. */
const EPSILON = 1e-5;
/** Slide iterations per horizontal move. */
const MAX_SLIDES = 4;

/** How far a sweep that hit at `hitDistance` may move: a skin short of the hit, never past `wanted`. */
function clampMove(hitDistance: number, wanted: number): number {
  return Math.min(wanted, Math.max(hitDistance - SKIN, 0));
}

export function createMoverState(position: Vec3, yaw = 0): MoverState {
  return {
    position: { ...position },
    velocity: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    grounded: false,
    groundNormal: { ...UP },
    crouching: false,
    airborne: 'fall',
    jumpTick: 0,
    apexTick: 0,
    doubleJumped: false,
    wallDodged: false,
    dodgeReadyTick: 0,
    jumpWasDown: false,
    footstepMeters: 0,
  };
}

/** Capsule dimensions for a standing or crouched pawn. */
export function pawnCapsule(crouching: boolean, cfg: Readonly<MovementConfig>): CapsuleDims {
  if (!crouching) return { ...PAWN_CAPSULE };
  const standingHeight = 2 * (PAWN_CAPSULE.halfHeight + PAWN_CAPSULE.radius);
  const height = Math.max(standingHeight * cfg.crouchHeightScale, 2 * PAWN_CAPSULE.radius);
  return { radius: PAWN_CAPSULE.radius, halfHeight: height / 2 - PAWN_CAPSULE.radius };
}

/** Distance from the capsule center down to the feet. */
export function feetOffset(capsule: CapsuleDims): number {
  return capsule.radius + capsule.halfHeight;
}

/** Feet (bottom of the capsule) for a pawn in `state`. */
export function feetPosition(state: Readonly<MoverState>, cfg: Readonly<MovementConfig>): Vec3 {
  const p = state.position;
  return { x: p.x, y: p.y - feetOffset(pawnCapsule(state.crouching, cfg)), z: p.z };
}

export class CharacterMover {
  /** Shared, live-tunable configuration. The dev panel mutates it in place. */
  readonly config: MovementConfig;

  constructor(
    readonly physics: PhysicsWorld,
    config: MovementConfig = { ...DEFAULT_MOVEMENT },
  ) {
    this.config = config;
  }

  /**
   * Register a pawn's capsule with the physics world at the state's position.
   * Call once after `createMoverState`; `removeActor` on the physics world removes it.
   */
  addPawn(pawn: EntityId, state: Readonly<MoverState>): void {
    this.physics.addActor(pawn, state.position, pawnCapsule(state.crouching, this.config));
  }

  /** Teleport a pawn: sets its position, clears velocity and drops it to find the ground. */
  teleport(pawn: EntityId, state: MoverState, position: Readonly<Vec3>, yaw?: number): void {
    state.position = { ...position };
    state.velocity = { x: 0, y: 0, z: 0 };
    if (yaw !== undefined) state.yaw = yaw;
    state.grounded = false;
    state.airborne = 'fall';
    state.wallDodged = false;
    state.doubleJumped = false;
    this.syncPhysics(pawn, state);
  }

  /**
   * Set the pawn's velocity from outside the movement rules (jump pads §4,
   * knockback). The pawn leaves the ground; a double jump is not available
   * from a launch but a wall dodge is. The `jumpPad` event is the caller's.
   */
  launch(state: MoverState, velocity: Readonly<Vec3>): void {
    state.velocity = { ...velocity };
    state.grounded = false;
    state.airborne = 'launch';
    state.wallDodged = false;
    state.doubleJumped = false;
  }

  /** Advance one pawn by one tick. */
  step(pawn: EntityId, state: MoverState, input: Readonly<InputCommand>, tick: Tick): MoveResult {
    const cfg = this.config;
    const dt = TICK_DT;
    const events: SimEvent[] = [];
    let damage = 0;

    // View.
    state.yaw = Number.isFinite(input.yaw) ? input.yaw : state.yaw;
    state.pitch = clampPitch(input.pitch);

    // Crouch (standing up needs head room).
    this.updateCrouch(pawn, state, (input.buttons & Buttons.Crouch) !== 0);

    // Gravity on a pawn that started the tick airborne.
    if (!state.grounded) state.velocity.y -= cfg.gravity * dt;

    // Dodge: a ground dodge, or a wall dodge pushing off a wall behind the dodge direction.
    const dodge = dodgeDirection(input.buttons, state.yaw);
    if (dodge && tick >= state.dodgeReadyTick && !state.crouching) {
      const wall = !state.grounded;
      if (!wall || (!state.wallDodged && this.wallBehind(pawn, state, dodge))) {
        state.velocity = {
          x: dodge.x * cfg.dodgeSpeed,
          y: cfg.dodgeUpSpeed,
          z: dodge.z * cfg.dodgeSpeed,
        };
        state.grounded = false;
        state.airborne = 'dodge';
        if (wall) state.wallDodged = true;
        state.dodgeReadyTick = tick + Math.max(1, Math.round(cfg.dodgeCooldown * TICK_RATE));
        events.push({ type: 'dodge', tick, pawn, wall });
      }
    }

    // Jump on press: from the ground, or a double jump near the apex of a jump.
    const jumpDown = (input.buttons & Buttons.Jump) !== 0;
    const jumpPressed = jumpDown && !state.jumpWasDown;
    state.jumpWasDown = jumpDown;
    if (jumpPressed) {
      if (state.grounded) {
        state.velocity.y = cfg.jumpSpeed;
        state.grounded = false;
        state.airborne = 'jump';
        state.jumpTick = tick;
        state.apexTick =
          tick + Math.round((cfg.jumpSpeed / Math.max(cfg.gravity, 1e-3)) * TICK_RATE);
        state.doubleJumped = false;
        events.push({ type: 'jump', tick, pawn, double: false });
      } else if (this.canDoubleJump(state, tick)) {
        state.velocity.y = cfg.doubleJumpSpeed;
        state.doubleJumped = true;
        events.push({ type: 'jump', tick, pawn, double: true });
      }
    }

    // Acceleration from the move axes.
    const wish = wishDirection(input, state.yaw);
    const maxSpeed = cfg.groundSpeed * (state.crouching ? cfg.crouchSpeedScale : 1);
    const accel = groundAcceleration(cfg) * (state.crouching ? cfg.crouchSpeedScale : 1);
    if (state.grounded) {
      state.velocity = accelerateGround(state.velocity, wish, maxSpeed, accel, dt);
      state.velocity.y = 0;
    } else {
      state.velocity = accelerateAir(state.velocity, wish, maxSpeed, accel * cfg.airControl, dt);
    }

    // Move: horizontal sweep with slide and step-up, then vertical sweep with ground snap.
    const capsule = pawnCapsule(state.crouching, cfg);
    const wasGrounded = state.grounded;
    const start = { ...state.position };
    let center = this.moveHorizontal(pawn, state, capsule, state.position, {
      x: state.velocity.x * dt,
      y: 0,
      z: state.velocity.z * dt,
    });

    const rise = state.velocity.y * dt;
    if (rise > EPSILON) {
      const hit = this.physics.castShape({ type: 'capsule', ...capsule }, center, UP, rise + SKIN, {
        ignoreActor: pawn,
      });
      if (hit) {
        center = add(center, scale(UP, clampMove(hit.distance, rise)));
        // A ceiling stops the rise; a grazed wall only limits the move.
        if (hit.normal.y < -0.3 && state.velocity.y > 0) state.velocity.y = 0;
      } else {
        center = add(center, scale(UP, rise));
      }
      state.grounded = false;
    } else {
      const drop = -rise + (wasGrounded ? cfg.groundSnap : 0);
      const hit = this.physics.castShape(
        { type: 'capsule', ...capsule },
        center,
        DOWN,
        drop + SKIN,
        { ignoreActor: pawn },
      );
      const ground = hit && this.groundNormalAt(pawn, hit.normal, center, capsule, drop);
      if (hit && ground) {
        // Settle exactly a skin above the ground (lifting out of it if need be).
        center = add(center, scale(DOWN, Math.min(hit.distance - SKIN, drop)));
        const impact = -state.velocity.y;
        state.velocity.y = 0;
        state.groundNormal = ground;
        if (!wasGrounded) {
          events.push({ type: 'land', tick, pawn, impactSpeed: impact });
          damage = fallDamage(impact, cfg);
          state.airborne = 'none';
          state.wallDodged = false;
          state.doubleJumped = false;
        }
        state.grounded = true;
      } else if (hit) {
        // Too steep to stand on: stop at the surface and slide along it.
        center = add(center, scale(DOWN, clampMove(hit.distance, drop)));
        state.velocity = projectOnPlane(state.velocity, hit.normal);
        this.leaveGround(state, wasGrounded);
      } else {
        center = add(center, scale(DOWN, -rise));
        this.leaveGround(state, wasGrounded);
      }
    }

    state.position = center;
    this.syncPhysics(pawn, state);

    // Footsteps while walking.
    if (state.grounded && wasGrounded && horizontalSpeed(state.velocity) > 0.5) {
      state.footstepMeters += Math.hypot(state.position.x - start.x, state.position.z - start.z);
      if (state.footstepMeters >= cfg.footstepDistance) {
        state.footstepMeters = 0;
        events.push({ type: 'footstep', tick, pawn, position: { ...state.position } });
      }
    } else {
      state.footstepMeters = 0;
    }

    return { events, fallDamage: damage };
  }

  // -- Rules ----------------------------------------------------------------

  private canDoubleJump(state: Readonly<MoverState>, tick: Tick): boolean {
    const cfg = this.config;
    if (state.airborne !== 'jump' || state.doubleJumped) return false;
    if (state.velocity.y > cfg.doubleJumpRiseLimit) return false;
    return tick <= state.apexTick + Math.round(cfg.doubleJumpWindow * TICK_RATE);
  }

  /** A wall within `wallDodgeDistance` opposite the dodge direction, as UT2004 traces it. */
  private wallBehind(pawn: EntityId, state: Readonly<MoverState>, dodge: Readonly<Vec3>): boolean {
    const cfg = this.config;
    const capsule = pawnCapsule(state.crouching, cfg);
    const hit = this.physics.castShape(
      { type: 'capsule', ...capsule },
      state.position,
      negate(dodge),
      cfg.wallDodgeDistance,
      { ignoreActor: pawn },
    );
    if (!hit) return false;
    // Not a ceiling, not a floor.
    return hit.normal.y > -0.1 && !isWalkable(hit.normal, cfg);
  }

  /**
   * Normal to stand on after a downward sweep hit, or null when the surface is
   * too steep. A capsule rolling over the edge of a walkable surface touches
   * the corner with a steep normal; a ray from the center tells a corner apart
   * from a real slope so the pawn walks off ledges instead of hopping.
   */
  private groundNormalAt(
    pawn: EntityId,
    hitNormal: Readonly<Vec3>,
    center: Readonly<Vec3>,
    capsule: CapsuleDims,
    drop: number,
  ): Vec3 | null {
    const cfg = this.config;
    if (isWalkable(hitNormal, cfg)) return { ...hitNormal };
    const ray = this.physics.raycast(center, DOWN, feetOffset(capsule) + drop + SKIN, {
      ignoreActor: pawn,
    });
    if (ray && isWalkable(ray.normal, cfg)) return { ...ray.normal };
    return null;
  }

  private leaveGround(state: MoverState, wasGrounded: boolean): void {
    state.grounded = false;
    if (wasGrounded) {
      state.airborne = 'fall';
      state.wallDodged = false;
      state.doubleJumped = false;
    }
  }

  /** Switch capsules about the feet; standing up needs head room. */
  private updateCrouch(pawn: EntityId, state: MoverState, wantCrouch: boolean): void {
    if (wantCrouch === state.crouching) return;
    const from = pawnCapsule(state.crouching, this.config);
    const to = pawnCapsule(wantCrouch, this.config);
    const center = {
      x: state.position.x,
      y: state.position.y - feetOffset(from) + feetOffset(to),
      z: state.position.z,
    };
    if (!wantCrouch) {
      // Shrunk by the skin so the floor the pawn rests on does not count as a blocker.
      const probe = {
        type: 'capsule',
        radius: to.radius - SKIN,
        halfHeight: to.halfHeight,
      } as const;
      if (this.physics.overlap(probe, center, { ignoreActor: pawn }).length > 0) return;
    }
    state.crouching = wantCrouch;
    state.position = center;
    const collider = this.physics.actorCollider(pawn);
    if (collider) collider.setShape(new this.physics.rapier.Capsule(to.halfHeight, to.radius));
  }

  // -- Sweeps ---------------------------------------------------------------

  /** Sweep the capsule along the horizontal `delta`, sliding along walls and stepping up ledges. */
  private moveHorizontal(
    pawn: EntityId,
    state: MoverState,
    capsule: CapsuleDims,
    center: Vec3,
    delta: Vec3,
  ): Vec3 {
    const cfg = this.config;
    const shape = { type: 'capsule', ...capsule } as const;
    let remaining = delta;
    for (let i = 0; i < MAX_SLIDES; i++) {
      const dist = length(remaining);
      if (dist <= EPSILON) break;
      const dir = scale(remaining, 1 / dist);
      const hit = this.physics.castShape(shape, center, dir, dist + SKIN, { ignoreActor: pawn });
      if (!hit) return add(center, remaining);
      if (hit.startedInside) {
        // Nudge out of whatever we are overlapping and try again.
        center = add(center, scale(hit.normal, SKIN * 2));
        continue;
      }
      const allowed = clampMove(hit.distance, dist);
      center = add(center, scale(dir, allowed));
      remaining = scale(dir, dist - allowed);

      const left = length(remaining);
      if (!isWalkable(hit.normal, cfg) && left > EPSILON) {
        if (state.grounded) {
          const stepped = this.tryStepUp(pawn, shape, center, dir, left);
          if (stepped) {
            center = stepped.center;
            state.groundNormal = stepped.normal;
            remaining = scale(dir, left - stepped.advanced);
            continue;
          }
        }
        // A wall: drop the velocity into it so the pawn does not keep pushing.
        if (dot(state.velocity, hit.normal) < 0) {
          const y = state.grounded ? 0 : state.velocity.y;
          state.velocity = projectOnPlane(state.velocity, hit.normal);
          state.velocity.y = y;
        }
      }
      remaining = projectOnPlane(remaining, hit.normal);
    }
    return center;
  }

  /**
   * Step-up: lift the capsule by up to `stepHeight`, move it forward, and set
   * it back down. Succeeds only when it lands on walkable ground higher than
   * where it started. Horizontal velocity is untouched (§4).
   */
  private tryStepUp(
    pawn: EntityId,
    shape: { type: 'capsule'; radius: number; halfHeight: number },
    center: Vec3,
    dir: Vec3,
    dist: number,
  ): { center: Vec3; normal: Vec3; advanced: number } | null {
    const cfg = this.config;
    if (cfg.stepHeight <= 0 || dist <= EPSILON) return null;
    const opts = { ignoreActor: pawn };

    const upHit = this.physics.castShape(shape, center, UP, cfg.stepHeight + SKIN, opts);
    const lift = upHit ? clampMove(upHit.distance, cfg.stepHeight) : cfg.stepHeight;
    if (lift <= EPSILON) return null;
    const top = add(center, scale(UP, lift));

    const fwdHit = this.physics.castShape(shape, top, dir, dist + SKIN, opts);
    const advanced = fwdHit ? clampMove(fwdHit.distance, dist) : dist;
    if (advanced <= EPSILON) return null;
    const ahead = add(top, scale(dir, advanced));

    const downHit = this.physics.castShape(shape, ahead, DOWN, lift + SKIN, opts);
    if (!downHit || downHit.startedInside) return null;
    let normal: Vec3 | null = isWalkable(downHit.normal, cfg) ? { ...downHit.normal } : null;
    if (!normal) {
      // The capsule touched the ledge's corner. Accept it only when the surface
      // under the capsule's leading edge is walkable and no higher than a step.
      const probe = add(ahead, scale(dir, shape.radius));
      const ray = this.physics.raycast(probe, DOWN, feetOffset(shape) + lift + SKIN, opts);
      const feetY = center.y - feetOffset(shape);
      if (ray && isWalkable(ray.normal, cfg) && ray.point.y <= feetY + cfg.stepHeight + SKIN) {
        normal = { ...ray.normal };
      }
    }
    if (!normal) return null;
    const landed = add(ahead, scale(DOWN, clampMove(downHit.distance, lift)));
    if (landed.y <= center.y + EPSILON) return null;
    return { center: landed, normal, advanced };
  }

  private syncPhysics(pawn: EntityId, state: Readonly<MoverState>): void {
    this.physics.setActorPosition(pawn, state.position);
  }
}
