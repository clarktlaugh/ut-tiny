/**
 * Effect recipes (docs/DESIGN.md §5, §8.3): what each weapon and event looks
 * like, expressed as emissions into the pooled subsystems. Numbers are the
 * tuning surface; `FxSystem` decides *when* to call these from `SimEvent`s.
 *
 * Everything random goes through the system's seeded `Rng`, so the same
 * events at the same ticks produce the same picture (fixed-tick screenshots).
 */
import type { DamageType, ProjectileType, Vec3, WeaponId } from '../../sim/types';
import { BEAM_LINGER } from '../../sim/weapons/shock';
import type { Rng } from '../../sim/rng';
import { Frame } from './atlas';
import type { BeamSpawn } from './beams';
import type { DecalSpawn } from './decals';
import type { FlashSpawn } from './flashes';
import type { FxSystem } from './fxSystem';
import type { GibSpawn } from './gibs';
import type { ParticleSpawn } from './particles';

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface MuzzleFx {
  /** Flash color and quad size (m). */
  color: number;
  size: number;
  /** Light flash peak intensity (0 = none). */
  light: number;
  /** Smoke puffs. */
  smoke: number;
}

/** Muzzle flash per weapon (both modes; grenade and rocket alt share the primary). */
export const MUZZLE_FX: Readonly<Record<WeaponId, MuzzleFx>> = {
  teleporter: { color: 0x7fd8ff, size: 0.5, light: 0, smoke: 0 },
  assault: { color: 0xffd98a, size: 0.7, light: 15, smoke: 1 },
  mines: { color: 0xb8ff9a, size: 0.5, light: 0, smoke: 1 },
  rocket: { color: 0xffb060, size: 1.6, light: 60, smoke: 5 },
  sniper: { color: 0xfff0c0, size: 1.1, light: 30, smoke: 2 },
  shock: { color: 0x8fd6ff, size: 1.3, light: 80, smoke: 0 },
  shockScoped: { color: 0x8fd6ff, size: 1.3, light: 80, smoke: 0 },
  redeemer: { color: 0xffffff, size: 2.5, light: 100, smoke: 10 },
};

export interface TracerFx {
  speed: number;
  segment: number;
  width: number;
  color: number;
  coreColor: number;
}

/** Travelling tracers for bullet weapons. */
export const TRACER_FX: Readonly<Partial<Record<WeaponId, TracerFx>>> = {
  assault: { speed: 420, segment: 4, width: 0.26, color: 0xffb84a, coreColor: 0xfff1c8 },
  sniper: { speed: 900, segment: 12, width: 0.3, color: 0xa8d8ff, coreColor: 0xffffff },
};

export interface BeamFx {
  width: number;
  color: number;
  coreColor: number;
  life: number;
}

/** Lingering beams (§5: the Super Shock beam stays `BEAM_LINGER` s). */
export const BEAM_FX: Readonly<Partial<Record<WeaponId, BeamFx>>> = {
  shock: { width: 1.1, color: 0x6a5cff, coreColor: 0xc8f4ff, life: BEAM_LINGER },
  shockScoped: { width: 1.1, color: 0x6a5cff, coreColor: 0xc8f4ff, life: BEAM_LINGER },
};

export interface ImpactFx {
  sparks: number;
  sparkColor: number;
  /** Decal size (m) and frame; 0 for none. */
  decalSize: number;
  decalFrame: number;
  decalColor: number;
  /** Shockwave ring size (m), 0 for none. */
  ring: number;
  ringColor: number;
  /** Light flash at the hit point, 0 for none. */
  light: number;
  lightColor: number;
}

/** What a hitscan shot does where it lands. */
export const IMPACT_FX: Readonly<Record<WeaponId, ImpactFx>> = {
  teleporter: {
    sparks: 0,
    sparkColor: 0,
    decalSize: 0,
    decalFrame: 0,
    decalColor: 0,
    ring: 0,
    ringColor: 0,
    light: 0,
    lightColor: 0,
  },
  assault: {
    sparks: 6,
    sparkColor: 0xffc060,
    decalSize: 0.35,
    decalFrame: Frame.Hole,
    decalColor: 0x151311,
    ring: 0,
    ringColor: 0,
    light: 0,
    lightColor: 0,
  },
  mines: {
    sparks: 0,
    sparkColor: 0,
    decalSize: 0,
    decalFrame: 0,
    decalColor: 0,
    ring: 0,
    ringColor: 0,
    light: 0,
    lightColor: 0,
  },
  rocket: {
    sparks: 0,
    sparkColor: 0,
    decalSize: 0,
    decalFrame: 0,
    decalColor: 0,
    ring: 0,
    ringColor: 0,
    light: 0,
    lightColor: 0,
  },
  sniper: {
    sparks: 12,
    sparkColor: 0xffe0a0,
    decalSize: 0.5,
    decalFrame: Frame.Hole,
    decalColor: 0x100e0c,
    ring: 0,
    ringColor: 0,
    light: 20,
    lightColor: 0xffe0a0,
  },
  shock: {
    sparks: 14,
    sparkColor: 0x9ad8ff,
    decalSize: 1.6,
    decalFrame: Frame.Scorch,
    decalColor: 0x1a1030,
    ring: 3,
    ringColor: 0x9ad8ff,
    light: 120,
    lightColor: 0x7fb8ff,
  },
  shockScoped: {
    sparks: 14,
    sparkColor: 0x9ad8ff,
    decalSize: 1.6,
    decalFrame: Frame.Scorch,
    decalColor: 0x1a1030,
    ring: 3,
    ringColor: 0x9ad8ff,
    light: 120,
    lightColor: 0x7fb8ff,
  },
  redeemer: {
    sparks: 0,
    sparkColor: 0,
    decalSize: 0,
    decalFrame: 0,
    decalColor: 0,
    ring: 0,
    ringColor: 0,
    light: 0,
    lightColor: 0,
  },
};

export interface ExplosionFx {
  /** Splash radius the counts below are tuned for; other radii scale from it. */
  referenceRadius: number;
  fire: number;
  smoke: number;
  sparks: number;
  debris: number;
  fireColor: number;
  smokeColor: number;
  light: { color: number; intensity: number; distance: number; life: number };
  /** Scorch decal size as a fraction of the radius (0 = none). */
  scorch: number;
  /** Seconds of screen flash for observers inside ~1.6 radii (Redeemer: 1.5). */
  screenFlash: number;
}

const ROCKET_BLAST: ExplosionFx = {
  referenceRadius: 4.4,
  fire: 14,
  smoke: 12,
  sparks: 18,
  debris: 6,
  fireColor: 0xff9a3c,
  smokeColor: 0x5a5652,
  light: { color: 0xffa040, intensity: 220, distance: 28, life: 0.3 },
  scorch: 0.8,
  screenFlash: 0,
};

/** Explosion looks by damage type (`explosion` events). */
export const EXPLOSION_FX: Readonly<Partial<Record<DamageType, ExplosionFx>>> = {
  rocket: ROCKET_BLAST,
  grenade: { ...ROCKET_BLAST, fireColor: 0xffb050, smokeColor: 0x6b6a60 },
  mine: { ...ROCKET_BLAST, fireColor: 0xd0ff70 },
  redeemer: {
    referenceRadius: 50,
    fire: 90,
    smoke: 70,
    sparks: 80,
    debris: 24,
    fireColor: 0xffe0a0,
    smokeColor: 0x7a7470,
    light: { color: 0xfff0d0, intensity: 4000, distance: 180, life: 1.5 },
    scorch: 0.5,
    screenFlash: 1.5,
  },
};

export interface TrailFx {
  /** Meters between smoke puffs. */
  spacing: number;
  smokeSize: number;
  smokeColor: number;
  smokeLife: number;
  /** Head glow size (m), 0 for none. */
  glow: number;
  glowColor: number;
}

/** Projectile trails, emitted every update along the path travelled since the last one. */
export const TRAIL_FX: Readonly<Record<ProjectileType, TrailFx | null>> = {
  rocket: {
    spacing: 0.6,
    smokeSize: 0.8,
    smokeColor: 0x9c9890,
    smokeLife: 1.1,
    glow: 1,
    glowColor: 0xffa040,
  },
  grenade: {
    spacing: 1.2,
    smokeSize: 0.4,
    smokeColor: 0x9c9890,
    smokeLife: 0.6,
    glow: 0,
    glowColor: 0,
  },
  redeemer: {
    spacing: 0.4,
    smokeSize: 2.2,
    smokeColor: 0xe8e4dc,
    smokeLife: 2.5,
    glow: 2.5,
    glowColor: 0xffd080,
  },
  disc: {
    spacing: 1,
    smokeSize: 0.3,
    smokeColor: 0x7fd8ff,
    smokeLife: 0.3,
    glow: 0.4,
    glowColor: 0x7fd8ff,
  },
};

/** Gibs per death and how far they fly. */
export const GIB_FX = { count: 10, speed: 9, blood: 14, color: 0x8a1818, life: 4 } as const;

/** Decal lifetimes, seconds. */
export const DECAL_LIFE = { hole: 25, scorch: 40 } as const;

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

const P: ParticleSpawn = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  life: 1,
  size0: 1,
  size1: 1,
  color0: 0xffffff,
  color1: 0xffffff,
  alpha0: 1,
  alpha1: 0,
  frame: Frame.Glow,
  rotation: 0,
  spin: 0,
  gravity: 0,
  drag: 0,
};
const B: BeamSpawn = {
  kind: 'linger',
  from: { x: 0, y: 0, z: 0 },
  to: { x: 0, y: 0, z: 0 },
  width: 1,
  color: 0xffffff,
  coreColor: 0xffffff,
  life: 1,
  speed: 1,
  segment: 1,
};
const L: FlashSpawn = {
  position: { x: 0, y: 0, z: 0 },
  color: 0xffffff,
  intensity: 1,
  distance: 10,
  life: 0.1,
};
const D: DecalSpawn = {
  position: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  size: 1,
  frame: Frame.Hole,
  color: 0,
  alpha: 1,
  rotation: 0,
  life: 10,
};
const G: GibSpawn = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  spin: { x: 0, y: 0, z: 0 },
  size: 1,
  color: 0xffffff,
  life: 1,
  floorY: -Infinity,
};
/**
 * Scratch vectors. `inner` belongs to the emission helpers (`sparks`, `smoke`,
 * `drops`); recipes use `dir` and `pt` and may pass them to the helpers, never
 * the other way round.
 */
const inner: Vec3 = { x: 0, y: 0, z: 0 };
const dir: Vec3 = { x: 0, y: 0, z: 0 };
const pt: Vec3 = { x: 0, y: 0, z: 0 };
/** Unit up vector shared by the recipes. */
const UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });

const setV = (v: Vec3, x: number, y: number, z: number): Vec3 => {
  v.x = x;
  v.y = y;
  v.z = z;
  return v;
};
const copyV = (v: Vec3, from: Readonly<Vec3>): Vec3 => setV(v, from.x, from.y, from.z);

/** Uniform random unit vector. */
export function randomDirection(rng: Rng, out: Vec3): Vec3 {
  const z = rng.nextRange(-1, 1);
  const a = rng.nextRange(0, Math.PI * 2);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return setV(out, Math.cos(a) * r, z, Math.sin(a) * r);
}

/** Random unit vector within `halfAngle` of `dir` (unit). */
export function randomCone(rng: Rng, axis: Readonly<Vec3>, halfAngle: number, out: Vec3): Vec3 {
  randomDirection(rng, out);
  const k = Math.cos(halfAngle);
  // Blend toward the axis and renormalise: cheap, good enough for sparks.
  out.x = out.x * (1 - k) + axis.x * k;
  out.y = out.y * (1 - k) + axis.y * k;
  out.z = out.z * (1 - k) + axis.z * k;
  const len = Math.hypot(out.x, out.y, out.z) || 1;
  return setV(out, out.x / len, out.y / len, out.z / len);
}

function resetParticle(): ParticleSpawn {
  P.rotation = 0;
  P.spin = 0;
  P.gravity = 0;
  P.drag = 0;
  P.alpha0 = 1;
  P.alpha1 = 0;
  setV(P.velocity, 0, 0, 0);
  return P;
}

/** A soft additive glow that grows and fades. */
export function glow(
  fx: FxSystem,
  at: Readonly<Vec3>,
  color: number,
  size: number,
  life: number,
  frame: number = Frame.Glow,
): void {
  const p = resetParticle();
  copyV(p.position, at);
  p.life = life;
  p.size0 = size;
  p.size1 = size * 1.6;
  p.color0 = color;
  p.color1 = color;
  p.frame = frame;
  p.rotation = fx.rng.nextRange(0, Math.PI * 2);
  fx.light.emit(p);
}

/** Hot, gravity-bound sparks flying from `at` roughly along `dir`. */
export function sparks(
  fx: FxSystem,
  at: Readonly<Vec3>,
  along: Readonly<Vec3>,
  count: number,
  color: number,
  speed: number,
  halfAngle = Math.PI / 2,
): void {
  for (let i = 0; i < count; i++) {
    const p = resetParticle();
    copyV(p.position, at);
    randomCone(fx.rng, along, halfAngle, inner);
    const v = speed * fx.rng.nextRange(0.35, 1);
    setV(p.velocity, inner.x * v, inner.y * v, inner.z * v);
    p.life = fx.rng.nextRange(0.25, 0.7);
    p.size0 = fx.rng.nextRange(0.08, 0.18);
    p.size1 = 0.02;
    p.color0 = 0xffffff;
    p.color1 = color;
    p.frame = Frame.Spark;
    p.gravity = 1;
    p.drag = 1.5;
    fx.light.emit(p);
  }
}

/** Alpha-blended smoke or dust that drifts up and expands. */
export function smoke(
  fx: FxSystem,
  at: Readonly<Vec3>,
  count: number,
  color: number,
  size: number,
  life: number,
  spread: number,
  rise = 1,
): void {
  for (let i = 0; i < count; i++) {
    const p = resetParticle();
    randomDirection(fx.rng, inner);
    setV(
      p.position,
      at.x + inner.x * spread * fx.rng.nextFloat(),
      at.y + inner.y * spread * fx.rng.nextFloat(),
      at.z + inner.z * spread * fx.rng.nextFloat(),
    );
    const v = spread * fx.rng.nextRange(0.5, 2);
    setV(p.velocity, inner.x * v, inner.y * v + rise, inner.z * v);
    p.life = life * fx.rng.nextRange(0.7, 1.3);
    p.size0 = size * fx.rng.nextRange(0.6, 1);
    p.size1 = size * fx.rng.nextRange(2, 3);
    p.color0 = color;
    p.color1 = color;
    p.alpha0 = 0.55;
    p.alpha1 = 0;
    p.frame = Frame.Smoke;
    p.rotation = fx.rng.nextRange(0, Math.PI * 2);
    p.spin = fx.rng.nextRange(-1, 1);
    p.drag = 2;
    fx.matter.emit(p);
  }
}

/** Dark, opaque drops that fall and splat: blood and dirt. */
export function drops(
  fx: FxSystem,
  at: Readonly<Vec3>,
  along: Readonly<Vec3>,
  count: number,
  color: number,
  speed: number,
): void {
  for (let i = 0; i < count; i++) {
    const p = resetParticle();
    copyV(p.position, at);
    randomCone(fx.rng, along, Math.PI * 0.6, inner);
    const v = speed * fx.rng.nextRange(0.2, 1);
    setV(p.velocity, inner.x * v, inner.y * v + 1, inner.z * v);
    p.life = fx.rng.nextRange(0.4, 0.9);
    p.size0 = fx.rng.nextRange(0.1, 0.3);
    p.size1 = fx.rng.nextRange(0.15, 0.4);
    p.color0 = color;
    p.color1 = color;
    p.alpha0 = 0.95;
    p.alpha1 = 0.6;
    p.frame = Frame.Disc;
    p.gravity = 1;
    p.drag = 0.5;
    fx.matter.emit(p);
  }
}

/** An expanding ring (shockwave). */
export function ring(
  fx: FxSystem,
  at: Readonly<Vec3>,
  color: number,
  size: number,
  life: number,
): void {
  const p = resetParticle();
  copyV(p.position, at);
  p.life = life;
  p.size0 = size * 0.2;
  p.size1 = size;
  p.color0 = color;
  p.color1 = color;
  p.alpha0 = 0.9;
  p.frame = Frame.Ring;
  fx.light.emit(p);
}

export function flash(
  fx: FxSystem,
  at: Readonly<Vec3>,
  color: number,
  intensity: number,
  distance: number,
  life: number,
): void {
  if (intensity <= 0) return;
  copyV(L.position, at);
  L.color = color;
  L.intensity = intensity;
  L.distance = distance;
  L.life = life;
  fx.flashes.flash(L);
}

/** Place a decal on the surface found by probing from `point` back along `dir`. */
export function decalOnSurface(
  fx: FxSystem,
  point: Readonly<Vec3>,
  along: Readonly<Vec3>,
  size: number,
  frame: number,
  color: number,
  life: number,
): boolean {
  // Probe from slightly before the hit so a point exactly on the surface still hits it.
  setV(pt, point.x - along.x * 0.5, point.y - along.y * 0.5, point.z - along.z * 0.5);
  const hit = fx.surface(pt, along, 1.5);
  if (!hit) return false;
  copyV(D.position, hit.point);
  copyV(D.normal, hit.normal);
  D.size = size * fx.rng.nextRange(0.85, 1.15);
  D.frame = frame;
  D.color = color;
  D.alpha = 0.9;
  D.rotation = fx.rng.nextRange(0, Math.PI * 2);
  D.life = life;
  fx.decals.place(D);
  return true;
}

/** Probe start offset behind a hit point, meters. */
const BACK_OFF = 0.5;

const AXES: readonly Readonly<Vec3>[] = [
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/** Scorch the nearest surface within `reach` of `center` (down first). */
export function scorchNearest(
  fx: FxSystem,
  center: Readonly<Vec3>,
  reach: number,
  size: number,
  color: number,
): boolean {
  let best: ReturnType<typeof fx.surface> = null;
  for (const axis of AXES) {
    // Start a little behind the center so a blast exactly on a surface still finds it.
    setV(
      pt,
      center.x - axis.x * BACK_OFF,
      center.y - axis.y * BACK_OFF,
      center.z - axis.z * BACK_OFF,
    );
    const hit = fx.surface(pt, axis, reach + BACK_OFF);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  if (!best) return false;
  copyV(D.position, best.point);
  copyV(D.normal, best.normal);
  D.size = size;
  D.frame = Frame.Scorch;
  D.color = color;
  D.alpha = 0.85;
  D.rotation = fx.rng.nextRange(0, Math.PI * 2);
  D.life = DECAL_LIFE.scorch;
  fx.decals.place(D);
  return true;
}

// ---------------------------------------------------------------------------
// Event recipes
// ---------------------------------------------------------------------------

export function muzzleFlash(
  fx: FxSystem,
  weapon: WeaponId,
  origin: Readonly<Vec3>,
  direction: Readonly<Vec3>,
): void {
  const m = MUZZLE_FX[weapon];
  // Just ahead of the eye so the flash is not inside the camera.
  setV(
    pt,
    origin.x + direction.x * 0.9,
    origin.y + direction.y * 0.9 - 0.15,
    origin.z + direction.z * 0.9,
  );
  glow(fx, pt, m.color, m.size, 0.07, Frame.Flare);
  glow(fx, pt, m.color, m.size * 0.7, 0.05);
  flash(fx, pt, m.color, m.light, 8, 0.07);
  if (m.smoke) smoke(fx, pt, m.smoke, 0x8a8782, 0.4, 0.5, 0.15, 0.5);
}

export function tracer(
  fx: FxSystem,
  weapon: WeaponId,
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
): void {
  const t = TRACER_FX[weapon];
  if (!t) return;
  B.kind = 'tracer';
  copyV(B.from, from);
  copyV(B.to, to);
  B.width = t.width;
  B.color = t.color;
  B.coreColor = t.coreColor;
  B.life = 1;
  B.speed = t.speed;
  B.segment = t.segment;
  fx.beams.emit(B);
}

export function lingeringBeam(
  fx: FxSystem,
  weapon: WeaponId,
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
): void {
  const b = BEAM_FX[weapon];
  if (!b) return;
  B.kind = 'linger';
  copyV(B.from, from);
  copyV(B.to, to);
  B.width = b.width;
  B.color = b.color;
  B.coreColor = b.coreColor;
  B.life = b.life;
  B.speed = 1;
  B.segment = 1;
  fx.beams.emit(B);
}

/** Where a hitscan shot landed: sparks and a hole on world, a blood puff on a pawn. */
export function hitscanImpact(
  fx: FxSystem,
  weapon: WeaponId,
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
  hitPawn: boolean,
  headshot: boolean,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  setV(dir, dx / len, dy / len, dz / len);
  const back = setV(pt, -dir.x, -dir.y, -dir.z);
  const i = IMPACT_FX[weapon];
  if (hitPawn) {
    drops(fx, to, back, headshot ? 10 : 4, GIB_FX.color, 4);
    if (i.ring) ring(fx, to, i.ringColor, i.ring * 0.6, 0.25);
    return;
  }
  if (i.sparks) sparks(fx, to, back, i.sparks, i.sparkColor, 7, Math.PI * 0.45);
  if (i.ring) {
    ring(fx, to, i.ringColor, i.ring, 0.35);
    glow(fx, to, i.ringColor, i.ring * 0.7, 0.2);
  }
  if (i.light) flash(fx, to, i.lightColor, i.light, 10, 0.2);
  if (i.decalSize) {
    const life = i.decalFrame === Frame.Scorch ? DECAL_LIFE.scorch : DECAL_LIFE.hole;
    const placed = decalOnSurface(fx, to, dir, i.decalSize, i.decalFrame, i.decalColor, life);
    if (placed) smoke(fx, to, 1, 0x9a948c, i.decalSize * 0.8, 0.5, 0.05, 0.6);
  }
}

export function explosion(
  fx: FxSystem,
  center: Readonly<Vec3>,
  radius: number,
  damageType: DamageType,
): ExplosionFx | undefined {
  const e = EXPLOSION_FX[damageType];
  if (!e) return undefined;
  const scale = Math.max(0.3, radius / e.referenceRadius);
  const count = (n: number): number => Math.max(1, Math.round(n * Math.min(1, scale * 1.2)));
  // Core flash.
  glow(fx, center, 0xffffff, radius * 0.9, 0.12, Frame.Flare);
  glow(fx, center, e.fireColor, radius * 1.2, 0.3);
  ring(fx, center, e.fireColor, radius * 2.2, 0.35 * Math.sqrt(scale) + 0.1);
  // Fireball.
  for (let i = 0; i < count(e.fire); i++) {
    const p = resetParticle();
    randomDirection(fx.rng, dir);
    const r = radius * 0.3 * fx.rng.nextFloat();
    setV(p.position, center.x + dir.x * r, center.y + dir.y * r, center.z + dir.z * r);
    const v = radius * fx.rng.nextRange(0.8, 2.2);
    setV(p.velocity, dir.x * v, dir.y * v + radius * 0.3, dir.z * v);
    p.life = fx.rng.nextRange(0.25, 0.5) * (0.7 + 0.3 * Math.sqrt(scale));
    p.size0 = radius * fx.rng.nextRange(0.35, 0.6);
    p.size1 = radius * fx.rng.nextRange(0.7, 1.1);
    p.color0 = 0xfff0c0;
    p.color1 = e.fireColor;
    p.alpha1 = 0;
    p.frame = Frame.Glow;
    p.rotation = fx.rng.nextRange(0, Math.PI * 2);
    p.spin = fx.rng.nextRange(-2, 2);
    p.drag = 3;
    fx.light.emit(p);
  }
  // Smoke column, sparks, debris.
  smoke(fx, center, count(e.smoke), e.smokeColor, radius * 0.5, 1.4 + scale * 0.4, radius * 0.5, 2);
  sparks(fx, center, UP, count(e.sparks), e.fireColor, radius * 3.5, Math.PI);
  drops(fx, center, UP, count(e.debris), 0x2a2622, radius * 2.5);
  flash(
    fx,
    center,
    e.light.color,
    e.light.intensity * Math.min(1, scale * 1.5),
    e.light.distance * Math.max(0.5, Math.min(1, scale)),
    e.light.life,
  );
  if (e.scorch) scorchNearest(fx, center, radius * 0.6, radius * e.scorch * 2, 0x14110e);
  return e;
}

/** Gibs and blood for a death at `at`. `floorY` is where the chunks land. */
export function gibPawn(fx: FxSystem, at: Readonly<Vec3>, color: number, floorY: number): void {
  for (let i = 0; i < GIB_FX.count; i++) {
    randomDirection(fx.rng, dir);
    setV(G.position, at.x + dir.x * 0.3, at.y + fx.rng.nextRange(-0.6, 0.6), at.z + dir.z * 0.3);
    const v = GIB_FX.speed * fx.rng.nextRange(0.4, 1);
    setV(G.velocity, dir.x * v, Math.abs(dir.y) * v + 3, dir.z * v);
    setV(G.spin, fx.rng.nextRange(-12, 12), fx.rng.nextRange(-12, 12), fx.rng.nextRange(-12, 12));
    G.size = fx.rng.nextRange(0.7, 1.6);
    // Alternate flesh and armour-coloured chunks.
    G.color = i % 3 === 0 ? color : GIB_FX.color;
    G.life = GIB_FX.life * fx.rng.nextRange(0.8, 1.2);
    G.floorY = floorY;
    fx.gibs.emit(G);
  }
  drops(fx, at, UP, GIB_FX.blood, GIB_FX.color, 6);
  smoke(fx, at, 3, 0x5a2020, 0.8, 0.8, 0.4, 0.5);
}

/** A hit on a pawn: a few drops in the push direction. */
export function pawnHit(
  fx: FxSystem,
  at: Readonly<Vec3>,
  momentum: Readonly<Vec3>,
  amount: number,
): void {
  const len = Math.hypot(momentum.x, momentum.y, momentum.z);
  if (len > 1e-6) setV(dir, momentum.x / len, momentum.y / len, momentum.z / len);
  else setV(dir, 0, 1, 0);
  drops(fx, at, dir, Math.min(6, 1 + Math.floor(amount / 15)), GIB_FX.color, 3);
}

/** Trail puffs along `from → to` for a projectile, keeping `carry` meters of spacing debt. */
export function trail(
  fx: FxSystem,
  type: ProjectileType,
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
  carry: number,
): number {
  const t = TRAIL_FX[type];
  if (!t) return 0;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  let d = carry;
  while (d <= len) {
    const k = len > 0 ? d / len : 0;
    setV(pt, from.x + dx * k, from.y + dy * k, from.z + dz * k);
    smoke(fx, pt, 1, t.smokeColor, t.smokeSize, t.smokeLife, 0.1, 0.4);
    d += t.spacing;
  }
  if (t.glow) glow(fx, to, t.glowColor, t.glow, 0.06);
  return d - len;
}

/** Teleport: a flash at both ends. */
export function teleportFlash(fx: FxSystem, from: Readonly<Vec3>, to: Readonly<Vec3>): void {
  for (const at of [from, to]) {
    glow(fx, at, 0x7fd8ff, 2.5, 0.25);
    ring(fx, at, 0x7fd8ff, 3, 0.3);
    sparks(fx, at, UP, 10, 0x7fd8ff, 5, Math.PI);
    flash(fx, at, 0x7fd8ff, 20, 10, 0.2);
  }
}

/** Dust kicked up at a pawn's feet. */
export function dust(fx: FxSystem, feet: Readonly<Vec3>, amount: number): void {
  smoke(fx, feet, Math.max(1, Math.round(amount)), 0x9a948c, 0.6, 0.7, 0.4, 0.6);
}

/** Pickup taken: a short sparkle in the pickup's color. */
export function sparkle(fx: FxSystem, at: Readonly<Vec3>, color: number): void {
  glow(fx, at, color, 1.5, 0.3);
  sparks(fx, at, UP, 8, color, 3, Math.PI);
}
