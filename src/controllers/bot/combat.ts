/**
 * Combat seam for the bot (docs/DESIGN.md §9 "Combat"). P22 supplies the real
 * behavior under `src/controllers/bot/combat/` (per-weapon ranges, strafe and
 * dodge patterns, projectile leading, skill-based aim error and reaction).
 * `BasicCombat` here is the minimum that lets bots fight at all: aim at the
 * target, fire while it is visible and in range after the skill's reaction
 * delay, hold the best weapon, and strafe at a middle distance.
 */
import type { WeaponTable } from '../../sim/inventory';
import { bestWeapon, hasAmmo } from '../../sim/inventory';
import { rightVector } from '../../sim/movement';
import type { Rng } from '../../sim/rng';
import { Buttons, TICK_RATE, type PawnState, type Tick, type Vec3 } from '../../sim/types';
import { anglesFromDirection, eyePosition } from '../../sim/weapons/core';
import { distance, horizontalDirection } from './math';
import type { EnemyMemory } from './perception';
import type { SkillProfile } from './skill';

export interface CombatContext {
  tick: Tick;
  self: Readonly<PawnState>;
  target: Readonly<EnemyMemory>;
  weapons: WeaponTable;
  profile: SkillProfile;
  rng: Rng;
  /** True when a one-meter step in this horizontal direction stays on the navmesh. */
  canStep: (dir: Readonly<Vec3>) => boolean;
}

export interface CombatOutput {
  yaw: number;
  pitch: number;
  /** Fire buttons for this tick. */
  buttons: number;
  /** Horizontal unit move, or null to let the path follower move. */
  move: Vec3 | null;
  /** Weapon slot to request, 0 for none. */
  weapon: number;
}

export interface CombatBehavior {
  update(ctx: CombatContext): CombatOutput;
  reset(): void;
}

/** Distance the basic behavior tries to hold, m. */
export const PREFERRED_RANGE = 14;
/** Beyond this the basic behavior closes in instead of strafing, m. */
export const CLOSE_IN_RANGE = 24;
/** No fire beyond this, m. */
export const ENGAGE_RANGE = 70;

export class BasicCombat implements CombatBehavior {
  private strafeSign = 1;
  private strafeFlipTick = 0;

  reset(): void {
    this.strafeSign = 1;
    this.strafeFlipTick = 0;
  }

  update(ctx: CombatContext): CombatOutput {
    const { self, target, weapons, tick } = ctx;
    const eye = eyePosition(self);
    const lead = target.visible ? 0.08 : 0;
    const aim = {
      x: target.position.x + target.velocity.x * lead - eye.x,
      y: target.position.y + target.velocity.y * lead - eye.y,
      z: target.position.z + target.velocity.z * lead - eye.z,
    };
    const { yaw, pitch } = anglesFromDirection(aim);
    const dist = distance(self.position, target.position);

    let weapon = 0;
    const best = bestWeapon(self, weapons);
    if (best && self.weapon !== best && self.pendingWeapon === null) weapon = weapons[best].slot;

    let buttons = 0;
    const reacted = tick - target.sightedAt >= ctx.profile.reactionSeconds * TICK_RATE;
    const armed = self.weapon !== null && hasAmmo(self, self.weapon, weapons);
    if (target.visible && reacted && armed && dist <= ENGAGE_RANGE) buttons |= Buttons.Fire;

    let move: Vec3 | null = null;
    if (target.visible && dist <= CLOSE_IN_RANGE && self.grounded) {
      if (tick >= this.strafeFlipTick) {
        this.strafeSign = ctx.rng.nextBool() ? 1 : -1;
        this.strafeFlipTick = tick + Math.round(ctx.rng.nextRange(0.5, 1.5) * TICK_RATE);
      }
      const toward = horizontalDirection(self.position, target.position);
      const right = rightVector(yaw);
      const back = dist < PREFERRED_RANGE * 0.6 && toward ? -0.7 : 0;
      const candidate = (sign: number): Vec3 => ({
        x: right.x * sign + (toward?.x ?? 0) * back,
        y: 0,
        z: right.z * sign + (toward?.z ?? 0) * back,
      });
      let dir = candidate(this.strafeSign);
      if (!ctx.canStep(dir)) {
        this.strafeSign = -this.strafeSign;
        this.strafeFlipTick = tick + Math.round(0.5 * TICK_RATE);
        dir = candidate(this.strafeSign);
        if (!ctx.canStep(dir)) return { yaw, pitch, buttons, move: null, weapon };
      }
      const len = Math.hypot(dir.x, dir.z);
      move = len > 1e-6 ? { x: dir.x / len, y: 0, z: dir.z / len } : null;
    }
    return { yaw, pitch, buttons, move, weapon };
  }
}
